import "./java.js";
import "./typescript/index.js";
import "./javascript/index.js";
import "./python/index.js";
import "./rust/index.js";
import "./go/index.js";
import "./java/enterprise/spring-mvc.js";
import "./java/enterprise/dependency-injection.js";
import "./java/enterprise/transactions.js";
import "./java/enterprise/jpa-entity.js";
import "./java/enterprise/spring-data.js";

let bootstrapped = false;

/** Ensure every source-language and enterprise registry is loaded exactly once. */
export function ensureLanguageBootstrap() {
  bootstrapped = true;
  return bootstrapped;
}
