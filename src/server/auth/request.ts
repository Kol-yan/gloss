// The only auth module that depends on Next's request context. Import it from
// route handlers and server components; scripts and tests use sessions.ts.
import { cookies } from "next/headers";
import { requireLearnerFromToken, SESSION_COOKIE, type Learner } from "./sessions";

// Reads the session cookie of the current request. Throws UnauthorizedError
// when there is no valid session. There is no default learner.
export async function requireLearner(): Promise<Learner> {
  // cookies() also keeps the caller out of prerendering before the database is touched.
  const store = await cookies();
  return requireLearnerFromToken(store.get(SESSION_COOKIE)?.value);
}
