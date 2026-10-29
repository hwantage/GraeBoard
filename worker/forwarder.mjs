import { onRequest } from "../functions/[[path]].js";

// Keep old Pages service bindings working after retiring the full Worker API.
// The gateway and Edge retain all origin, Access and account checks.
export default {
  fetch(request, env) {
    return onRequest({ request, env });
  },
};
