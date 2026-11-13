// The reference interpreter of the business-policy-v2 predicate language now lives in the policy
// engine (packages/policy-engine/src/gate-reference.ts), shared with the studio mock and the impact
// runner. Re-exported for the checkpoint-rule tests.
export { holds, interpretGate as interpret } from "../../packages/policy-engine/src/gate-reference.js";
