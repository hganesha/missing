/**
 * The diligence interpreter: a fixed Rego module that reads the policy's diligence block as data
 * (`data.business.diligence`, with precomputed paths in `data.business.diligenceIndex`). Only the
 * overlay conditions are generated per policy, as `diligence_fired` rules from the same predicate
 * emitter the gates use. `evaluate.ts` is its independent oracle; keep the two in step.
 */
export const DILIGENCE_REGO = String.raw`
# ---- diligence interpreter (fixed) -------------------------------------------------------

diligence_fired contains "" if false

diligence_rank(level) := i if {
	some i, candidate in data.business.diligence.levels
	candidate == level
}

diligence_legal_form := object.get(input, data.business.diligenceIndex.legalFormPath, null)

diligence_products := [product | some product in object.get(input, ["scope", "products"], []); is_string(product)]

diligence_aliases := object.get(data.business.diligence, "productAliases", {})

# A taxonomy id's prefixes, most specific first: PAY.CARDS.DEBIT, PAY.CARDS, PAY.
diligence_prefixes(id) := [concat(".", array.slice(parts, 0, count(parts) - i)) |
	parts := split(id, ".")
	some i in numbers.range(0, count(parts) - 1)
]

# The legacy product ids that map to a taxonomy node, sorted.
diligence_aliases_of(node) := sort([legacy | some legacy, target in diligence_aliases; target == node])

# A node's prefixes, each preceded by the legacy ids that map to it (other than the product itself).
diligence_alias_steps(product, canonical) := [step |
	some node in diligence_prefixes(canonical)
	some step in array.concat([legacy | some legacy in diligence_aliases_of(node); legacy != product], [node])
]

# A case product's lineage, most specific first (contracts aliasLineage).
diligence_lineage(product) := diligence_alias_steps(product, product) if regex.match("^[A-Z]", product)

diligence_lineage(product) := array.concat([product], diligence_alias_steps(product, alias)) if {
	not regex.match("^[A-Z]", product)
	alias := object.get(diligence_aliases, product, null)
	is_string(alias)
}

diligence_lineage(product) := [product] if {
	not regex.match("^[A-Z]", product)
	not is_string(object.get(diligence_aliases, product, null))
}

# The matrix column a product takes: the most specific entry of its lineage the matrix has.
diligence_column(product) := matched[0] if {
	matched := [node | some node in diligence_lineage(product); node in data.business.diligence.products]
	count(matched) > 0
}

diligence_customer_type := object.get(input, ["scope", "customerType"], null)

diligence_configuration := object.get(input, ["configuration"], {})

diligence_party_ids contains party.id if {
	some party in data.business.diligence.partyTypes
	some form in party.legalForms
	form == diligence_legal_form
}

diligence_party := party if {
	count(diligence_party_ids) == 1
	some party in data.business.diligence.partyTypes
	party.id in diligence_party_ids
}

diligence_mandatory := object.get(diligence_configuration, "mandatory_overlays", [])

diligence_switched_on contains overlay.id if {
	some overlay in data.business.diligence.overlays
	overlay.enabled == true
}

diligence_switched_on contains overlay.id if {
	some overlay in data.business.diligence.overlays
	is_array(diligence_mandatory)
	some entry in diligence_mandatory
	entry == overlay.id
}

# An overlay's scope (evaluate.ts overlayInScope): each part it names must hold.
diligence_scope_products(overlay) if not overlay.appliesTo.products

diligence_scope_products(overlay) if {
	some product in diligence_products
	some node in diligence_lineage(product)
	node in overlay.appliesTo.products
}

diligence_scope_parties(overlay) if not overlay.appliesTo.partyTypes

diligence_scope_parties(overlay) if count(diligence_party_ids) != 1

diligence_scope_parties(overlay) if diligence_party.id in overlay.appliesTo.partyTypes

diligence_scope_jurisdictions(overlay) if not overlay.appliesTo.jurisdictions

diligence_scope_jurisdictions(overlay) if object.get(input, ["scope", "jurisdiction"], null) in overlay.appliesTo.jurisdictions

diligence_enabled contains overlay.id if {
	some overlay in data.business.diligence.overlays
	overlay.id in diligence_switched_on
	diligence_scope_products(overlay)
	diligence_scope_parties(overlay)
	diligence_scope_jurisdictions(overlay)
}

diligence_gaps contains {"code": "DILIGENCE_INPUT_MISSING", "path": data.business.diligence.inputs.legalForm, "subjectId": null} if {
	diligence_legal_form == null
}

diligence_gaps contains {"code": "DILIGENCE_PARTY_TYPE_UNKNOWN", "path": data.business.diligence.inputs.legalForm, "subjectId": null} if {
	diligence_legal_form != null
	count(diligence_party_ids) != 1
}

diligence_gaps contains {"code": "DILIGENCE_PARTY_TYPE_SCOPE_MISMATCH", "path": "/scope/customerType", "subjectId": null} if {
	diligence_party.customerType != diligence_customer_type
}

diligence_gaps contains {"code": "DILIGENCE_ROLE_REQUIREMENTS_MISSING", "path": concat("", ["/scope/relatedProducts/", entry.product]), "subjectId": null} if {
	some entry in diligence_related
	not is_array(object.get(diligence_role_requirements, entry.role, null))
}

diligence_gaps contains {"code": "DILIGENCE_PRODUCTS_MISSING", "path": "/scope/products", "subjectId": null} if {
	count(diligence_products) == 0
}

diligence_gaps contains {"code": "DILIGENCE_PRODUCT_NOT_IN_MATRIX", "path": concat("", ["/scope/products/", product]), "subjectId": null} if {
	some product in diligence_products
	not diligence_column(product)
}

diligence_gaps contains {"code": "DILIGENCE_INPUT_MISSING", "path": pointer, "subjectId": null} if {
	some overlay in data.business.diligence.overlays
	overlay.id in diligence_enabled
	some i, pointer in overlay.requires
	object.get(input, data.business.diligenceIndex.requires[overlay.id][i], null) == null
}

diligence_cells contains {"id": concat(".", ["diligence.cell", diligence_party.id, column]), "rank": diligence_rank(level)} if {
	some product in diligence_products
	column := diligence_column(product)
	level := data.business.diligence.matrix[diligence_party.id][column]
}

diligence_base := max({cell.rank | some cell in diligence_cells})

diligence_floor_keys(product) := {concat(":", [who, node]) |
	some node in array.concat(diligence_lineage(product), ["*"])
	some who in [diligence_customer_type, "*"]
}

diligence_floors contains {"id": concat("", ["diligence.floor.", key]), "rank": diligence_rank(level)} if {
	floors := object.get(diligence_configuration, "diligence_floors", {})
	is_object(floors)
	is_string(diligence_customer_type)
	some product in diligence_products
	some key in diligence_floor_keys(product)
	level := floors[key]
	is_string(level)
}

diligence_floored := max({diligence_base} | {floor.rank | some floor in diligence_floors})

diligence_top := count(data.business.diligence.levels) - 1

diligence_overlay_rank(overlay) := diligence_rank(overlay.effect.escalateTo) if {
	overlay.effect.escalateTo
}

diligence_overlay_rank(overlay) := min({diligence_floored + overlay.effect.escalateBy, diligence_top}) if {
	overlay.effect.escalateBy
}

# A rule that does not escalate leaves the level where the floors put it.
diligence_overlay_rank(overlay) := diligence_floored if {
	not overlay.effect.escalateTo
	not overlay.effect.escalateBy
}

diligence_rule(rule_id) := overlay if {
	some overlay in data.business.diligence.overlays
	overlay.id == rule_id
}

diligence_fired_rules := sort({overlay.id | some overlay in diligence_overlays})

# Requirements rules added, rules by id and each in authored order (with repeats).
diligence_added := [requirement |
	some rule_id in diligence_fired_rules
	some requirement in object.get(diligence_rule(rule_id).effect, "addRequirements", [])
]

diligence_added_before(i, requirement) if {
	some j, other in diligence_added
	j < i
	other == requirement
}

# Products the customer holds in another role, and the requirements their roles bring.
diligence_related := [entry |
	some entry in object.get(input, ["scope", "relatedProducts"], [])
	is_object(entry)
	is_string(object.get(entry, "product", null))
	is_string(object.get(entry, "role", null))
]

diligence_role_requirements := object.get(data.business.diligence, "roleRequirements", {})

diligence_related_roles := sort({entry.role | some entry in diligence_related})

# Rule-added then role-added requirements, in order (with repeats).
diligence_extra := array.concat(diligence_added, [requirement |
	some role in diligence_related_roles
	some requirement in object.get(diligence_role_requirements, role, [])
])

diligence_extra_before(i, requirement) if {
	some j, other in diligence_extra
	j < i
	other == requirement
}

diligence_requirements(level) := array.concat(object.get(data.business.diligence.requirements, level, []), [requirement |
	some i, requirement in diligence_extra
	not requirement in object.get(data.business.diligence.requirements, level, [])
	not diligence_extra_before(i, requirement)
])

diligence_screening_types(level) := sort([screening_type |
	some screening_type, obligation in object.get(data.business.diligence, "screening", {})
	obligation in diligence_requirements(level)
])

diligence_requirement_sources(level) := [{"requirement": requirement, "from": array.concat(
	[concat("", ["diligence.level.", level]) | requirement in object.get(data.business.diligence.requirements, level, [])],
	array.concat(
		[rule_id | some rule_id in diligence_fired_rules; requirement in object.get(diligence_rule(rule_id).effect, "addRequirements", [])],
		[concat("", ["diligence.role.", role]) | some role in diligence_related_roles; requirement in object.get(diligence_role_requirements, role, [])],
	),
)} | some requirement in diligence_requirements(level)]

diligence_approvals := [{"ruleId": rule_id, "role": approval.role, "quorum": approval.quorum, "reason": approval.reason} |
	some rule_id in diligence_fired_rules
	approval := diligence_rule(rule_id).effect.requireApproval
]

diligence_overlays contains {"id": overlay.id, "rank": diligence_overlay_rank(overlay)} if {
	some overlay in data.business.diligence.overlays
	overlay.id in diligence_enabled
	overlay.id in diligence_fired
}

diligence_before := max({diligence_floored} | {overlay.rank | some overlay in diligence_overlays})

diligence_permission_blocked if {
	data.business.diligence.simplifiedLevel == data.business.diligence.levels[diligence_before]
	object.get(diligence_configuration, "simplified_due_diligence_permitted", false) != true
}

diligence_final := diligence_before + 1 if diligence_permission_blocked

diligence_final := diligence_before if not diligence_permission_blocked

diligence_listed(kind, items) := [{"kind": kind, "id": item_id, "level": data.business.diligence.levels[item.rank]} |
	some item_id in sort({item.id | some item in items})
	some item in items
	item.id == item_id
]

diligence_raising_floors := {floor | some floor in diligence_floors; floor.rank > diligence_base}

diligence_permission := [{"kind": "permission", "id": "diligence.permission.sdd", "level": data.business.diligence.levels[diligence_final]}] if diligence_permission_blocked

diligence_permission := [] if not diligence_permission_blocked

diligence_contributors := array.concat(
	array.concat(diligence_listed("cell", diligence_cells), diligence_listed("floor", diligence_raising_floors)),
	array.concat(diligence_listed("overlay", diligence_overlays), diligence_permission),
)

diligence_gap_list := [gap |
	some gap_key in sort({concat("|", [gap.code, gap.path]) | some gap in diligence_gaps})
	some gap in diligence_gaps
	concat("|", [gap.code, gap.path]) == gap_key
]

diligence_result := {
	"state": "UNRESOLVED", "reasonCodes": sort({gap.code | some gap in diligence_gaps}), "ruleIds": [], "actions": [],
	"humanRequirement": null, "gaps": diligence_gap_list,
} if count(diligence_gaps) > 0

diligence_result := {
	"state": "DECIDED", "reasonCodes": [concat("", ["DILIGENCE_LEVEL_", level])],
	"ruleIds": [contributor.id | some contributor in diligence_contributors], "actions": [], "humanRequirement": null, "gaps": [],
	"outputs": {"diligence": {
		"level": level, "baseLevel": data.business.diligence.levels[diligence_base], "partyType": diligence_party.id,
		"products": sort(diligence_products), "requirements": diligence_requirements(level),
		"contributors": diligence_contributors, "requirementSources": diligence_requirement_sources(level), "approvals": diligence_approvals,
		"screeningTypes": diligence_screening_types(level),
	}},
} if {
	count(diligence_gaps) == 0
	level := data.business.diligence.levels[diligence_final]
}

result := diligence_result if input.gateId == data.business.diligence.gateId
`;
