# Credentials the demo scripts present to the internal services.
#
# The scripts stand in for the control surface, so they authenticate as the edge and
# carry an acting persona. Callers spread the array into curl: "${edge_auth[@]}".
edge_token="${EDGE_SERVICE_TOKEN:-local-edge-service-token-change-before-sharing}"
demo_actor="${DEMO_ACTOR_ID:-local-operator}"
demo_roles="${DEMO_ACTOR_ROLES:-Harness.Reader,Harness.Author,Harness.Operator,Case.Analyst,Case.Reviewer}"

edge_auth=(
  -H "authorization: Bearer ${edge_token}"
  -H "x-actor-id: ${demo_actor}"
  -H "x-actor-roles: ${demo_roles}"
)
