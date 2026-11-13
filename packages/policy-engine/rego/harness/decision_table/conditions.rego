# Condition extraction for decision tables.
#
# Every rule here resolves one slice of the case snapshot to one discrete token. The token
# vocabulary is small and closed on purpose: it is what lets the same authored table drive
# this bundle and the TypeScript reference evaluator, and it is what makes an evaluation
# replayable from the recorded condition values alone.
#
# Two invariants hold throughout:
#   - Every extractor is total. Missing, null or malformed input yields UNKNOWN, never an
#     undefined rule that would leave a condition absent from the result.
#   - UNKNOWN never satisfies anything. There is no token here meaning "absent, so fine".
package harness.decision_table.conditions

import rego.v1

catalog := data.harness.decision_table.catalog

snapshot := input.snapshot

# ---------------------------------------------------------------- entry point

# Resolve one authored condition to its token.
resolve(cond) := token if {
	token := declared(cond, extract(cond.extractor))
}

# A token an extractor produced but the condition never declared would match no row and land
# on the table default. Report it as undetermined instead, which routes to a human.
declared(cond, raw) := raw if raw in cond.tokens

declared(cond, raw) := "UNKNOWN" if not raw in cond.tokens

# ---------------------------------------------------------------- shared helpers

path_get(obj, p) := object.get(obj, split(p, "."), null)

to_str(v) := v if is_string(v)

to_str(v) := sprintf("%v", [v]) if not is_string(v)

norm_digest(v) := lower(trim_prefix(v, "sha256:")) if is_string(v)

norm_digest(v) := "" if not is_string(v)

pinned_digest := norm_digest(object.get(snapshot, ["policyAuthority", "policySnapshotDigest"], null))

# Age in whole days between two RFC3339 instants, inclusive of the limit. Evidence dated in
# the future is not fresh, it is wrong, so a negative age never falls inside a window.
within_days(from_ts, to_ts, days) if {
	f := time.parse_rfc3339_ns(from_ts)
	t := time.parse_rfc3339_ns(to_ts)
	age := (t - f) / 86400000000000
	age >= 0
	age <= days
}

before(a_ts, b_ts) if {
	time.parse_rfc3339_ns(a_ts) < time.parse_rfc3339_ns(b_ts)
}

collection(name) := object.get(snapshot, name, [])

where_matches(item, where) if {
	every k, v in where {
		object.get(item, k, null) == v
	}
}

# ---------------------------------------------------------------- cohort assignment

# The cohort is recomputed from case attributes rather than read off a label on the case: a
# cohort decides whether automatic approval is in scope at all, so a cohort an agent could
# write would be a cohort an agent could choose for itself.
attributes[name] := value if {
	some name, p in catalog.cohort_attribute_paths
	value := path_get(snapshot, p)
}

attributes_known if {
	every name in catalog.cohort_required_attributes {
		object.get(attributes, name, null) != null
	}
}

selector_matches(actual, expected) if {
	is_array(expected)
	actual in expected
}

selector_matches(actual, expected) if {
	not is_array(expected)
	actual == expected
}

cohort_matches(cohort) if {
	every key, expected in cohort.selector {
		selector_matches(object.get(attributes, key, null), expected)
	}
}

# Indices into the authored precedence, so the most restrictive match wins deterministically.
cohort_indices := [i |
	some i
	cid := catalog.cohort_precedence[i]
	cohort_matches(catalog.risk_cohorts[cid])
]

cohort_id := catalog.cohort_precedence[sort(cohort_indices)[0]] if {
	attributes_known
	count(cohort_indices) > 0
}

cohort_id := null if not attributes_known

cohort_id := null if {
	attributes_known
	count(cohort_indices) == 0
}

cohort := catalog.risk_cohorts[cohort_id] if cohort_id != null

# ---------------------------------------------------------------- evidence obligations

obligation_required_for(o) if "*" in o.requiredFor

obligation_required_for(o) if cohort_id in o.requiredFor

digest_ok(e) if pinned_digest == ""

digest_ok(e) if e.policySnapshotDigest == null

digest_ok(e) if {
	pinned_digest != ""
	is_string(e.policySnapshotDigest)
	norm_digest(e.policySnapshotDigest) == pinned_digest
}

evidence_applies(o, e) if {
	e.purpose == o.purpose
	e.sourceType in o.acceptableSourceTypes
	digest_ok(e)
}

freshness_ok(o, e) if o.freshnessDays == null

freshness_ok(o, e) if {
	o.freshnessDays != null
	within_days(e.recordedAt, snapshot.evaluatedAt, o.freshnessDays)
}

obligation_satisfied(o) if {
	some e in snapshot.evidence
	evidence_applies(o, e)
	freshness_ok(o, e)
}

# Evidence of the right kind exists but has aged out. Distinguished from absence because the
# two call for different work: refresh something, versus go and find it.
obligation_expired(o) if {
	o.freshnessDays != null
	some e in snapshot.evidence
	evidence_applies(o, e)
	not within_days(e.recordedAt, snapshot.evaluatedAt, o.freshnessDays)
}

obligation_selected(ex, oid) if not "obligations" in object.keys(ex)

obligation_selected(ex, oid) if oid in ex.obligations

required_obligations(ex) := [o |
	some oid, o in catalog.obligations
	obligation_selected(ex, oid)
	not oid in ex.exclude
	obligation_required_for(o)
]

any_obligation_missing(ex) if {
	some o in required_obligations(ex)
	not obligation_satisfied(o)
	not obligation_expired(o)
}

any_obligation_expired(ex) if {
	some o in required_obligations(ex)
	not obligation_satisfied(o)
	obligation_expired(o)
}

# ---------------------------------------------------------------- extractors

# evaluationStatus ------------------------------------------------
extract(ex) := "OK" if {
	ex.kind == "evaluationStatus"
	snapshot.evaluationError == null
}

extract(ex) := "ERROR" if {
	ex.kind == "evaluationStatus"
	snapshot.evaluationError != null
}

# snapshotFreshness -----------------------------------------------
extract(ex) := "UNKNOWN" if {
	ex.kind == "snapshotFreshness"
	snapshot.currentSequence == null
}

extract(ex) := "STALE" if {
	ex.kind == "snapshotFreshness"
	snapshot.currentSequence != null
	snapshot.currentSequence > snapshot.caseSequence
}

extract(ex) := "CURRENT" if {
	ex.kind == "snapshotFreshness"
	snapshot.currentSequence != null
	snapshot.currentSequence <= snapshot.caseSequence
}

# riskCohort ------------------------------------------------------
extract(ex) := "RESOLVED" if {
	ex.kind == "riskCohort"
	cohort_id != null
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "riskCohort"
	cohort_id == null
}

# cohortEligibility -----------------------------------------------
extract(ex) := "UNKNOWN" if {
	ex.kind == "cohortEligibility"
	cohort_id == null
}

extract(ex) := "ELIGIBLE" if {
	ex.kind == "cohortEligibility"
	cohort_id != null
	cohort.automaticApprovalEligible == true
}

extract(ex) := "NOT_ELIGIBLE" if {
	ex.kind == "cohortEligibility"
	cohort_id != null
	cohort.automaticApprovalEligible == false
}

# attestationStatus -----------------------------------------------
extract(ex) := "UNKNOWN" if {
	ex.kind == "attestationStatus"
	cohort_id == null
}

# A cohort that needs no attestation cannot be approved automatically anyway; reporting VALID
# keeps the attestation row from masking the eligibility row's reason code.
extract(ex) := "VALID" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == false
}

extract(ex) := "MISSING" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation == null
}

extract(ex) := "MISSING" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation != null
	snapshot.attestation.cohortId != cohort_id
}

extract(ex) := "EXPIRED" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation != null
	snapshot.attestation.cohortId == cohort_id
	snapshot.attestation.status == "EXPIRED"
}

extract(ex) := "MISSING" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation != null
	snapshot.attestation.cohortId == cohort_id
	snapshot.attestation.status == "REVOKED"
}

extract(ex) := "EXPIRED" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation != null
	snapshot.attestation.cohortId == cohort_id
	snapshot.attestation.status == "VALID"
	snapshot.attestation.expiresAt != null
	before(snapshot.attestation.expiresAt, snapshot.evaluatedAt)
}

extract(ex) := "VALID" if {
	ex.kind == "attestationStatus"
	cohort_id != null
	cohort.requiresAttestation == true
	snapshot.attestation != null
	snapshot.attestation.cohortId == cohort_id
	snapshot.attestation.status == "VALID"
	attestation_unexpired
}

attestation_unexpired if snapshot.attestation.expiresAt == null

attestation_unexpired if {
	snapshot.attestation.expiresAt != null
	not before(snapshot.attestation.expiresAt, snapshot.evaluatedAt)
}

# recommendationCitations -----------------------------------------
extract(ex) := "UNKNOWN" if {
	ex.kind == "recommendationCitations"
	snapshot.recommendation == null
}

extract(ex) := "COMPLETE" if {
	ex.kind == "recommendationCitations"
	snapshot.recommendation != null
	citations_complete
}

extract(ex) := "INCOMPLETE" if {
	ex.kind == "recommendationCitations"
	snapshot.recommendation != null
	not citations_complete
}

# A decline must additionally say which finding it rests on; an approval need not, because
# there may be nothing adverse to cite.
finding_citation_ok if snapshot.recommendation.outcome != "DECLINE"

finding_citation_ok if {
	snapshot.recommendation.outcome == "DECLINE"
	count(snapshot.recommendation.findingRefs) > 0
}

citations_complete if {
	count(snapshot.recommendation.policyRuleRefs) > 0
	count(snapshot.recommendation.evidenceRefs) > 0
	finding_citation_ok
}

# presence --------------------------------------------------------
presence_hit(ex) if {
	some item in collection(ex.collection)
	where_matches(item, ex.where)
}

extract(ex) := ex.presentToken if {
	ex.kind == "presence"
	presence_hit(ex)
}

extract(ex) := ex.absentToken if {
	ex.kind == "presence"
	not presence_hit(ex)
}

# attributesComplete ----------------------------------------------
field_present(o, f) if {
	v := object.get(o, f, null)
	v != null
	v != ""
}

attributes_container(ex) := c if {
	c := path_get(snapshot, ex.path)
	is_object(c)
}

all_fields_present(ex) if {
	every f in ex.required {
		field_present(attributes_container(ex), f)
	}
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "attributesComplete"
	not is_object(path_get(snapshot, ex.path))
}

extract(ex) := "COMPLETE" if {
	ex.kind == "attributesComplete"
	is_object(path_get(snapshot, ex.path))
	all_fields_present(ex)
}

extract(ex) := "INCOMPLETE" if {
	ex.kind == "attributesComplete"
	is_object(path_get(snapshot, ex.path))
	not all_fields_present(ex)
}

# itemStatus ------------------------------------------------------
matching_items(ex) := [item |
	some item in collection(ex.collection)
	where_matches(item, ex.where)
]

item_mapped(ex) := m if {
	some item in matching_items(ex)
	m := object.get(ex.map, object.get(item, ex.statusPath, ""), null)
	m != null
}

extract(ex) := ex.absent if {
	ex.kind == "itemStatus"
	count(matching_items(ex)) == 0
}

extract(ex) := item_mapped(ex) if {
	ex.kind == "itemStatus"
	count(matching_items(ex)) > 0
	item_mapped(ex) != null
}

extract(ex) := ex.otherwise if {
	ex.kind == "itemStatus"
	count(matching_items(ex)) > 0
	not item_mapped(ex)
}

# strongestFinding ------------------------------------------------
finding_in_scope(ex, f) if ex.openOnly == false

finding_in_scope(ex, f) if {
	ex.openOnly == true
	f.status == "OPEN"
}

rank_hits(ex) := [i |
	some i
	r := ex.ranking[i]
	some f in snapshot.findings
	finding_in_scope(ex, f)
	f.findingType == r.findingType
]

extract(ex) := ex.ranking[sort(rank_hits(ex))[0]].token if {
	ex.kind == "strongestFinding"
	count(rank_hits(ex)) > 0
}

extract(ex) := ex.absentToken if {
	ex.kind == "strongestFinding"
	count(rank_hits(ex)) == 0
}

# digestMatch -----------------------------------------------------
left_claims(ex) := [c |
	some c in snapshot.claims
	where_matches(c, ex.left.where)
]

digest_token(l, r) := "UNKNOWN" if l == ""

digest_token(l, r) := "UNKNOWN" if {
	l != ""
	r == ""
}

digest_token(l, r) := "MATCH" if {
	l != ""
	r != ""
	l == r
}

digest_token(l, r) := "MISMATCH" if {
	l != ""
	r != ""
	l != r
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "digestMatch"
	count(left_claims(ex)) == 0
}

extract(ex) := digest_token(
	norm_digest(path_get(left_claims(ex)[0], ex.left.valuePath)),
	norm_digest(path_get(snapshot, ex.right.path)),
) if {
	ex.kind == "digestMatch"
	count(left_claims(ex)) > 0
}

# obligationFreshness ---------------------------------------------
freshness_obligation(ex) := catalog.obligations[ex.obligation]

freshness_evidence(ex) := [e |
	some e in snapshot.evidence
	e.purpose == freshness_obligation(ex).purpose
]

any_freshness_ok(ex) if {
	some e in freshness_evidence(ex)
	within_days(e.recordedAt, snapshot.evaluatedAt, freshness_obligation(ex).freshnessDays)
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "obligationFreshness"
	count(freshness_evidence(ex)) == 0
}

extract(ex) := "FRESH" if {
	ex.kind == "obligationFreshness"
	count(freshness_evidence(ex)) > 0
	freshness_obligation(ex).freshnessDays == null
}

extract(ex) := "FRESH" if {
	ex.kind == "obligationFreshness"
	count(freshness_evidence(ex)) > 0
	freshness_obligation(ex).freshnessDays != null
	any_freshness_ok(ex)
}

extract(ex) := "STALE" if {
	ex.kind == "obligationFreshness"
	count(freshness_evidence(ex)) > 0
	freshness_obligation(ex).freshnessDays != null
	not any_freshness_ok(ex)
}

# obligationsSatisfied --------------------------------------------
extract(ex) := "UNKNOWN" if {
	ex.kind == "obligationsSatisfied"
	cohort_id == null
}

extract(ex) := "NOT_APPLICABLE" if {
	ex.kind == "obligationsSatisfied"
	cohort_id != null
	count(required_obligations(ex)) == 0
}

# Absence outranks expiry when both are present: a wholly missing obligation is the larger
# problem and names the work that has to happen first.
extract(ex) := "UNSATISFIED" if {
	ex.kind == "obligationsSatisfied"
	cohort_id != null
	count(required_obligations(ex)) > 0
	any_obligation_missing(ex)
}

extract(ex) := "EXPIRED" if {
	ex.kind == "obligationsSatisfied"
	cohort_id != null
	count(required_obligations(ex)) > 0
	not any_obligation_missing(ex)
	any_obligation_expired(ex)
}

extract(ex) := "SATISFIED" if {
	ex.kind == "obligationsSatisfied"
	cohort_id != null
	count(required_obligations(ex)) > 0
	not any_obligation_missing(ex)
	not any_obligation_expired(ex)
}

# providerHealth --------------------------------------------------
provider_result(ex, p) := path_get(snapshot, concat(".", [ex.basePath, p]))

providers_present(ex) if {
	is_object(path_get(snapshot, ex.basePath))
	every p in ex.providers {
		is_object(provider_result(ex, p))
	}
}

provider_has(ex, status) if {
	some p in ex.providers
	provider_result(ex, p).status == status
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "providerHealth"
	not providers_present(ex)
}

extract(ex) := "UNAVAILABLE" if {
	ex.kind == "providerHealth"
	providers_present(ex)
	provider_has(ex, "UNAVAILABLE")
}

extract(ex) := "DEGRADED" if {
	ex.kind == "providerHealth"
	providers_present(ex)
	not provider_has(ex, "UNAVAILABLE")
	provider_has(ex, "DEGRADED")
}

extract(ex) := "COMPLETE" if {
	ex.kind == "providerHealth"
	providers_present(ex)
	not provider_has(ex, "UNAVAILABLE")
	not provider_has(ex, "DEGRADED")
}

# listFreshness ---------------------------------------------------
list_published(ex) := path_get(snapshot, concat(".", [ex.basePath, ex.provider, "listPublishedAt"]))

list_max_age(ex) := object.get(catalog.owner_inputs, split(ex.maxAgeDaysOwnerInput, "."), null)

extract(ex) := "UNKNOWN" if {
	ex.kind == "listFreshness"
	list_published(ex) == null
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "listFreshness"
	list_published(ex) != null
	not is_number(list_max_age(ex))
}

extract(ex) := "FRESH" if {
	ex.kind == "listFreshness"
	list_published(ex) != null
	is_number(list_max_age(ex))
	within_days(list_published(ex), snapshot.evaluatedAt, list_max_age(ex))
}

extract(ex) := "STALE" if {
	ex.kind == "listFreshness"
	list_published(ex) != null
	is_number(list_max_age(ex))
	not within_days(list_published(ex), snapshot.evaluatedAt, list_max_age(ex))
}

# value -----------------------------------------------------------
extract(ex) := ex.absentToken if {
	ex.kind == "value"
	path_get(snapshot, ex.path) == null
}

extract(ex) := to_str(path_get(snapshot, ex.path)) if {
	ex.kind == "value"
	path_get(snapshot, ex.path) != null
	to_str(path_get(snapshot, ex.path)) in ex.domain
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "value"
	path_get(snapshot, ex.path) != null
	not to_str(path_get(snapshot, ex.path)) in ex.domain
}

# booleanValue ----------------------------------------------------
extract(ex) := "TRUE" if {
	ex.kind == "booleanValue"
	path_get(snapshot, ex.path) == true
}

extract(ex) := "FALSE" if {
	ex.kind == "booleanValue"
	path_get(snapshot, ex.path) == false
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "booleanValue"
	not is_boolean(path_get(snapshot, ex.path))
}

# numericThreshold ------------------------------------------------
threshold_minimum(ex) := object.get(catalog.owner_inputs, split(ex.minimumOwnerInput, "."), null)

extract(ex) := "UNKNOWN" if {
	ex.kind == "numericThreshold"
	not is_number(path_get(snapshot, ex.path))
}

extract(ex) := "UNKNOWN" if {
	ex.kind == "numericThreshold"
	is_number(path_get(snapshot, ex.path))
	not is_number(threshold_minimum(ex))
}

extract(ex) := "AT_OR_ABOVE" if {
	ex.kind == "numericThreshold"
	is_number(path_get(snapshot, ex.path))
	is_number(threshold_minimum(ex))
	path_get(snapshot, ex.path) >= threshold_minimum(ex)
}

extract(ex) := "BELOW" if {
	ex.kind == "numericThreshold"
	is_number(path_get(snapshot, ex.path))
	is_number(threshold_minimum(ex))
	path_get(snapshot, ex.path) < threshold_minimum(ex)
}
