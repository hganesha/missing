# The decision-table gate evaluator.
#
# A generic interpreter for authored decision tables, not a transcription of any one of
# them. The policy lives in `data.harness.decision_table.catalog`, emitted from the YAML
# catalog by the compiler, so a policy change is a reviewable diff of rows with a new bundle
# digest rather than a rewrite of generated Rego that nobody reads. Both halves are pinned
# by digest in the bundle manifest.
#
# Input:  {"gate": "<gate id>", "snapshot": {<case snapshot>}}
# Output: data.kyc.gate.decision
package harness.decision_table.gate

import rego.v1

import data.harness.decision_table.conditions

catalog := data.harness.decision_table.catalog

table_id := catalog.gate_tables[input.gate]

table := catalog.tables[table_id]

# Every condition the table declares, resolved, whether or not the matched row looked at it.
# Recording all of them is what makes an evaluation replayable without the original case.
condition_values[cid] := value if {
	some cond in table.conditions
	cid := cond.id
	value := conditions.resolve(cond)
}

expected_matches(actual, expected) if {
	is_array(expected)
	actual in expected
}

expected_matches(actual, expected) if {
	is_string(expected)
	actual == expected
}

row_matches(row) if {
	every cid, expected in row.when {
		expected_matches(condition_values[cid], expected)
	}
}

# Hit policy is first-match. The authored row order is the reviewable artifact -- serious
# reasons are placed ahead of lesser ones so the analyst is shown the worst problem -- so the
# lowest matching index wins rather than any set-iteration order.
matching_rows := [i |
	some i
	row_matches(table.rows[i])
]

matched_row := table.rows[sort(matching_rows)[0]] if count(matching_rows) > 0

reason_code := catalog.reason_codes[decision.reasonCode]

decision := {
	"gateId": input.gate,
	"tableId": table_id,
	"policyId": catalog.policy_id,
	"policyVersion": catalog.policy_version,
	"policyBundleDigest": catalog.bundle_digest,
	"outcome": matched_row.outcome,
	"reasonCode": matched_row.reasonCode,
	"matchedRowId": matched_row.id,
	"ruleIds": matched_row.rules,
	"transitionTo": object.get(matched_row, "transitionTo", null),
	"disposition": object.get(matched_row, "disposition", null),
	"escalation": object.get(matched_row, "escalation", null),
	"cohortId": conditions.cohort_id,
	"conditionValues": condition_values,
} if {
	count(matching_rows) > 0
}

# Nothing falls through to approval: an unmatched combination is the table default, which the
# catalog loader refuses to let be ALLOW.
decision := {
	"gateId": input.gate,
	"tableId": table_id,
	"policyId": catalog.policy_id,
	"policyVersion": catalog.policy_version,
	"policyBundleDigest": catalog.bundle_digest,
	"outcome": table.default.outcome,
	"reasonCode": table.default.reasonCode,
	"matchedRowId": null,
	"ruleIds": table.default.rules,
	"transitionTo": null,
	"disposition": null,
	"escalation": null,
	"cohortId": conditions.cohort_id,
	"conditionValues": condition_values,
} if {
	count(matching_rows) == 0
}

# Where the outcome sends the case. Derived from the reason code registry so a queue is never
# named in two places and cannot drift between them.
route_to := reason_code.routeTo

result := object.union(decision, {"routeTo": route_to})
