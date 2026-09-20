# ContextSlice v1.4 — Java Enterprise Context Semantics

You are extending **ContextSlice**, a developer tool that reduces the amount of source code developers need to place into the context window of AI coding assistants such as Codex and Claude Code.

ContextSlice currently supports:

- Java
- TypeScript
- TSX
- Python work is planned/underway separately

The Java core is already strong on:

- symbol indexing
- overload handling
- call resolution
- minimum-sufficient context composition
- retrieval recall
- required-fact recall
- context reduction
- CLI/MCP workflow

The purpose of v1.4 is:

> Improve Java enterprise-context reconstruction so ContextSlice can recover framework-relevant semantics around a developer task without dumping entire classes, configuration files, or framework internals.

This milestone is specifically about **Java Enterprise Context Semantics**.

It is not a general Java parser rewrite.

It is not an excuse to add framework-specific magic without evidence.

It is not a JDT/LSP milestone.

---

## 1. Mandatory benchmark rule

No v1.4 semantic feature is complete without a reproducible benchmark.

Every semantic rule must be validated through:

- targeted fixtures
- real pinned repositories
- before/after measurements
- failure attribution
- regression comparison

Every implementation report must include:

- baseline
- after
- delta
- task-level impact
- context cost

Tests alone are not sufficient.

---

## 2. Primary objective

Improve ContextSlice on Java enterprise tasks involving:

- Spring MVC
- dependency injection
- transaction boundaries
- async/event boundaries
- scheduled work
- Spring Data repositories
- JPA relationships
- Kafka producers/consumers
- configuration/property references
- tests related to production symbols

The guiding question is:

> Can ContextSlice recover the enterprise-level semantics a developer needs while still constructing minimum sufficient context?

---

## 3. Preserve current Java baseline

Replay the existing Java benchmark unchanged before making changes.

Record current values explicitly.

Required regression gates:

```text
Java retrieval recall = 100%
Java required-fact recall = 100%
Java semantic call regression = none
```

Also preserve:

- no benchmark leakage
- conservative unresolved behavior
- whole-file avoidance
- package correctness
- CLI/MCP compatibility

---

## 4. Preserve TypeScript regression

Run the current TypeScript regression suite.

Required:

```text
TypeScript retrieval recall = 100%
TypeScript required-fact recall = 100%
TypeScript semantic call recall = 100%
TypeScript semantic call precision = 100%
```

Java enterprise work must not regress shared core behavior.

---

## 5. Framework-neutral architecture first

Do not scatter code like:

```java
if (annotation == "Transactional") ...
if (annotation == "KafkaListener") ...
```

through the core planner.

Prefer a framework-semantic extraction layer under the Java adapter.

Conceptually:

```text
Java AST
  ↓
Java structural model
  ↓
enterprise semantic extractors
  ↓
generic semantic relations
  ↓
context planner
```

Core planning should consume generic evidence where practical.

---

## 6. Enterprise semantic relation model

Introduce generic relation kinds such as:

```text
ROUTE_TO_HANDLER
INJECTS_DEPENDENCY
TRANSACTION_BOUNDARY
ASYNC_BOUNDARY
EVENT_HANDLER
SCHEDULED_ENTRYPOINT
PERSISTS_ENTITY
ENTITY_RELATION
REPOSITORY_QUERY
PRODUCES_MESSAGE
CONSUMES_MESSAGE
CONFIGURES_BEAN
READS_PROPERTY
TESTS_SYMBOL
```

Exact naming may differ.

Relations must include:

- source symbol
- target symbol/object when known
- confidence
- evidence
- source location
- estimated context value where useful

---

## 7. No runtime simulation

Do not simulate Spring runtime.

Do not pretend to know:

- proxy invocation order
- exact bean selection under ambiguous runtime conditions
- AOP chains
- conditional bean activation
- dynamic profile resolution

Represent static evidence conservatively.

---

## 8. Annotation extraction

Retain and normalize Java annotations relevant to enterprise semantics.

Examples:

- `@RestController`
- `@Controller`
- `@RequestMapping`
- `@GetMapping`
- `@PostMapping`
- `@PutMapping`
- `@DeleteMapping`
- `@PatchMapping`
- `@Transactional`
- `@Async`
- `@EventListener`
- `@Scheduled`
- `@KafkaListener`
- `@Configuration`
- `@Bean`
- `@Value`
- `@ConfigurationProperties`
- JPA annotations

Do not make every annotation semantic by default.

---

## 9. Spring MVC route semantics

Extract routes from:

```java
@RestController
@RequestMapping("/orders")
class OrderController {

    @PostMapping("/{id}")
    Order update(@PathVariable Long id) { ... }
}
```

Represent:

```text
POST /orders/{id}
→ OrderController.update
```

Preserve:

- HTTP method
- class-level path
- method-level path
- handler symbol
- annotations
- path variables/request params where structurally useful

---

## 10. Route composition

Combine:

- class-level `@RequestMapping`
- method-level route annotations

Do not require literal-only paths to function.

If expressions/constants cannot be statically resolved, retain raw annotation expression and lower confidence.

Do not guess.

---

## 11. Controller → service flow

Use existing call graph plus enterprise metadata to recover:

```text
HTTP route
→ controller method
→ service
→ repository / event / message
```

Do not hard-code "controller must call service".

Follow actual calls.

---

## 12. Dependency injection semantics

Recognize common static injection patterns:

- constructor injection
- field injection
- setter injection where explicit

Examples:

```java
OrderService(OrderRepository repo)
```

```java
@Autowired
private OrderService service;
```

Prefer constructor injection evidence when available.

---

## 13. Bean identity

When a field/constructor parameter type maps uniquely to a project class/interface, record a dependency edge.

If multiple candidates exist:

- preserve ambiguity
- lower confidence
- do not invent a bean winner

Qualifiers may be used as evidence if static.

---

## 14. @Qualifier

Support:

```java
@Qualifier("primaryOrderService")
OrderService service
```

as disambiguating metadata where the target bean identity is statically available.

Do not implement full Spring container resolution.

---

## 15. @Transactional

Extract transaction boundaries.

Example:

```java
@Transactional
public void transfer(...) { ... }
```

Include transaction metadata in context when the task concerns:

- data mutation
- repository writes
- consistency
- failure handling
- transaction behavior

Do not simulate propagation semantics unless annotation values are explicit and needed.

---

## 16. Transaction annotation attributes

Preserve relevant explicit values:

- propagation
- isolation
- readOnly
- rollbackFor
- noRollbackFor
- timeout

Only include them when present or task-relevant.

Do not dump full annotation text unnecessarily.

---

## 17. Transaction call-boundary caution

Do not claim that internal self-invocation triggers Spring proxy behavior.

If the analysis sees:

```java
this.transactionalMethod()
```

retain structural call evidence but do not claim proxy interception.

Document this limitation.

---

## 18. @Async

Extract async boundary metadata.

Example:

```java
@Async
public void sendEmail(...) { ... }
```

Use this when explaining flow or impact.

Do not claim thread/executor specifics unless statically configured and linked.

---

## 19. @EventListener

Extract event handler relationships.

Example:

```java
@EventListener
public void onOrderCreated(OrderCreated event) { ... }
```

Represent:

```text
OrderCreated
→ onOrderCreated
```

where event type is structurally explicit.

---

## 20. ApplicationEventPublisher

Recognize calls such as:

```java
publisher.publishEvent(new OrderCreated(...))
```

when target event type is statically clear.

Link:

```text
producer
→ event type
→ listener
```

Do not model dynamic event subclasses beyond available evidence.

---

## 21. @Scheduled

Extract scheduled entrypoints.

Preserve:

- method
- cron/fixedDelay/fixedRate expression
- property reference if used

Example:

```java
@Scheduled(cron = "${jobs.cleanup.cron}")
void cleanup() {}
```

Link property where possible.

---

## 22. Spring Data repository semantics

Recognize repository interfaces such as:

```java
interface UserRepository extends JpaRepository<User, Long>
```

Record:

- repository type
- entity type
- id type
- inherited repository role

Do not index framework implementation internals.

---

## 23. Derived query methods

Parse method names conservatively:

```java
findByEmail
findByStatusAndCreatedAtBefore
existsByExternalId
deleteByStatus
```

Extract structured hints only when unambiguous.

Do not build a full Spring Data parser unless benchmark evidence justifies it.

---

## 24. @Query

Support:

```java
@Query("select u from User u where u.email = :email")
Optional<User> findByEmail(...)
```

Include query text only when task-relevant.

Link:

- repository method
- entity type
- referenced properties if statically obvious

Do not attempt full JPQL/SQL semantic execution.

---

## 25. JPA entity semantics

Recognize:

- `@Entity`
- `@Id`
- `@EmbeddedId`
- `@Column`
- `@OneToOne`
- `@OneToMany`
- `@ManyToOne`
- `@ManyToMany`
- `@JoinColumn`
- `@JoinTable`
- `@MappedSuperclass`
- `@Embeddable`

Build a compact entity relationship model.

---

## 26. Entity relationship graph

Represent:

```text
Order
  many-to-one → Customer
  one-to-many → OrderItem
```

Include:

- owning field
- relation kind
- target type
- mappedBy/join metadata when explicit
- fetch/cascade only if explicitly specified and relevant

Do not infer database schema beyond annotations.

---

## 27. Lazy/eager metadata

Preserve explicit fetch mode.

Do not assume defaults unless they are required and deliberately encoded.

If defaults are reported, label them as framework defaults, not source-explicit facts.

Prefer source-explicit facts in context.

---

## 28. Cascade metadata

Preserve explicit cascade values when task-relevant.

Do not flood context with all JPA metadata by default.

---

## 29. Persistence flow

Use existing call graph + repository/entity metadata to reconstruct flows such as:

```text
controller
→ service
→ repository.save
→ Order entity
```

and:

```text
service
→ repository.findById
→ User entity
```

Do not claim actual SQL.

---

## 30. Kafka producer semantics

Recognize common producer calls structurally, for example:

```java
kafkaTemplate.send(topic, key, event)
```

Extract when statically available:

- producer symbol
- topic expression
- event/value type
- key expression type where useful

Do not hard-code exact overloads unless resolved.

---

## 31. @KafkaListener

Extract:

```java
@KafkaListener(topics = "orders")
void handle(OrderCreated event) {}
```

Represent:

```text
topic orders
→ handler
→ payload type OrderCreated
```

If topic is property-driven, link to property key.

---

## 32. Kafka producer → consumer linking

Link producer and consumer only when there is sufficient static evidence:

- same literal topic
- same resolved property key/value
- same constant
- compatible payload type if available

Do not link on vague string similarity.

---

## 33. Messaging neutrality

Design producer/consumer relation machinery so it could later support:

- RabbitMQ
- JMS
- other messaging

Do not bake Kafka-specific assumptions into core graph structures.

Kafka-specific extraction can remain in Java enterprise adapter logic.

---

## 34. Configuration classes

Recognize:

```java
@Configuration
class AppConfig {
  @Bean
  Foo foo(...) { ... }
}
```

Record bean-producing methods.

Link injected dependencies where deterministic.

Do not simulate Spring conditions.

---

## 35. @Bean

Treat `@Bean` methods as semantic configuration symbols.

Record:

- bean method
- return type
- dependencies via parameters
- explicit bean name if present

Do not infer runtime lifecycle beyond source evidence.

---

## 36. @ConfigurationProperties

Support:

```java
@ConfigurationProperties(prefix = "app.mail")
class MailProperties { ... }
```

Link property namespace to structured fields.

This can be useful for config-related tasks.

---

## 37. @Value

Support:

```java
@Value("${app.timeout}")
Duration timeout;
```

Extract property key where statically parseable.

Do not resolve SpEL broadly in v1.4.

---

## 38. Property files

Index relevant configuration keys from common project files where practical:

- `application.properties`
- `application.yml`
- `application.yaml`
- profile variants

Do not index all arbitrary YAML/Properties files by default.

---

## 39. Property linkage

Link:

```text
@Value("${app.timeout}")
→ app.timeout
```

and:

```text
@ConfigurationProperties(prefix="app.mail")
→ app.mail.*
```

where deterministic.

---

## 40. YAML/properties scope

If adding lightweight parsers for config files:

- keep them isolated
- avoid general YAML semantic ambitions
- index keys/values only as needed for Java context

Do not turn v1.4 into a config-language milestone.

---

## 41. Test linkage

Link production symbols to tests through structural evidence.

Examples:

- test imports target class
- test constructs target class
- test calls target method
- Spring test references route/service/repository

Support common test annotations as metadata:

- `@Test`
- `@ParameterizedTest`
- `@SpringBootTest`
- `@WebMvcTest`
- `@DataJpaTest`
- `@MockBean`

Do not simulate test runtime.

---

## 42. Production → test context

When task asks:

```text
what tests cover this?
what should I run after changing this?
```

ContextSlice should retrieve linked tests.

Do not include tests for every normal explanation task unless relevant.

---

## 43. Test linkage metric

Add:

```text
test_linkage_recall
test_linkage_precision
```

on independently grounded benchmark cases.

---

## 44. Enterprise context planner

Add enterprise relations as optional evidence to the existing context planner.

Priority should remain task-driven.

Do not globally include:

- all annotations
- all JPA relations
- all properties
- all tests
- all framework edges

Only include what helps the current task.

---

## 45. Explainability

Every enterprise-context inclusion must explain why.

Examples:

```text
OrderRepository
reason: persistence dependency
evidence: target calls repository.save
```

```text
orders.created
reason: messaging relationship
evidence: @KafkaListener topic matches producer topic
```

```text
app.timeout
reason: configuration dependency
evidence: @Value on target field
```

---

## 46. Confidence

Use conservative confidence levels.

Examples:

```text
EXACT
PROBABLE
UNRESOLVED
```

Do not mark framework relations exact unless source evidence justifies it.

---

## 47. No annotation spam

A method with many annotations should not cause all annotation metadata to enter context.

Use task relevance and relation relevance.

Measure token cost.

---

## 48. Enterprise semantic budget

Track additional tokens caused by enterprise semantics.

Add:

```text
enterprise_context_tokens
enterprise_context_ratio
```

The milestone must demonstrate semantic gain without runaway context growth.

---

## 49. Fact recovery efficiency

Add:

```text
enterprise_fact_recovery_efficiency =
newly recovered enterprise facts
--------------------------------
additional enterprise context tokens
```

Report per rule family.

---

## 50. Per-rule benchmark discipline

Benchmark semantic families separately where practical:

```text
baseline
+ Spring MVC
+ transaction/async/event
+ JPA/Spring Data
+ Kafka
+ config/property
+ test linkage
```

Record which family recovers which required facts.

Do not add six semantic families and report only aggregate success.

---

## 51. Feature retention rule

A semantic rule should remain only if it:

- recovers required facts, or
- improves retrieval, or
- reduces fallback, or
- lowers minimum sufficient budget, or
- fixes a real correctness issue

without unacceptable false positives or context inflation.

If a rule only adds tokens across real tasks and recovers no facts, remove it or leave it disabled.

---

## 52. Real benchmark repositories

Use real pinned Java repositories.

Target at least three repositories with enterprise coverage.

Recommended categories:

### Repository A — Spring MVC + JPA

Must include:

- controllers
- services
- repositories
- entities

### Repository B — Messaging / Kafka

Must include:

- producer
- consumer/listener
- event payloads
- service integration

### Repository C — Config + tests + enterprise structure

Must include:

- configuration
- properties
- tests
- dependency injection

Existing repositories may be reused where appropriate, but new enterprise tasks must be independently grounded.

---

## 53. Task count

Target:

```text
~18–24 real tasks
```

with coverage across:

- route flow
- transaction boundary
- persistence
- entity relation
- Kafka/message flow
- config dependency
- test impact
- change impact

Do not reduce task count merely to produce perfect metrics.

---

## 54. Independent required facts

Every task must define required facts independently from ContextSlice output.

Examples:

### Route task

```text
POST /orders
→ OrderController.create
→ OrderService.create
```

### Persistence task

```text
OrderService.create
→ OrderRepository.save
→ Order entity
```

### Messaging task

```text
producer sends OrderCreated
→ topic
→ listener consumes OrderCreated
```

Ground truth must be reviewed independently.

---

## 55. Mandatory metrics

Report:

```text
required_fact_recall
retrieval_recall
context_reduction
whole_file_fallback
whole_class_fallback
minimum_sufficient_budget
enterprise_context_tokens
enterprise_fact_recovery_efficiency
```

---

## 56. Enterprise-specific metrics

Add:

```text
route_linkage_recall
route_linkage_precision

transaction_boundary_recall

jpa_relation_recall
repository_linkage_recall

kafka_linkage_recall
kafka_linkage_precision

property_linkage_recall
property_linkage_precision

test_linkage_recall
test_linkage_precision
```

Only report metrics for grounded cases.

---

## 57. False semantic edge metric

Track:

```text
enterprise_false_positive_edges
```

A false exact enterprise relation is worse than an unresolved relation.

Conservative behavior is preferred.

---

## 58. Failure attribution

Every missing enterprise fact must be classified:

```text
TARGET_SELECTION
CONTEXT_COMPOSITION
TOKEN_BUDGET
SYMBOL_INDEX
CALL_RESOLUTION
ANNOTATION_EXTRACTION
ROUTE_RESOLUTION
DI_RESOLUTION
JPA_RESOLUTION
MESSAGING_RESOLUTION
CONFIG_RESOLUTION
TEST_LINKAGE
FRAMEWORK_RUNTIME_LIMIT
GROUND_TRUTH
UNKNOWN
```

---

## 59. Benchmark leakage guard

Production Java enterprise logic must not access:

- required facts
- expected routes
- expected repository targets
- expected topics
- expected properties
- benchmark answers

Add regression checks where practical.

---

## 60. No repo-specific hacks

Do not write logic such as:

```text
if package contains petclinic
if class name == OwnerController
if topic == orders
```

All rules must be generic.

---

## 61. No JDT/LSP by default

Do not add:

- Eclipse JDT
- Java Language Server
- compiler dependency

in v1.4 unless benchmark evidence proves a repeated required-fact loss that cannot reasonably be solved structurally.

At the end quantify:

```text
facts lost specifically due to missing compiler semantics
tasks harmed by unresolved Java typing
```

---

## 62. No Spring container bootstrap

Do not run Spring.

Do not start application contexts.

Do not execute project code.

ContextSlice remains static analysis.

---

## 63. Fixture corpus

Create:

```text
tests/fixtures/java-enterprise/
```

Cover at minimum:

- controller + class route
- method route
- constructor injection
- field injection
- qualifier
- transactional method
- transactional attributes
- async method
- event publisher/listener
- scheduled method
- JPA entity
- one-to-many
- many-to-one
- repository interface
- derived query
- @Query
- Kafka producer
- Kafka listener
- property-based topic
- @Configuration
- @Bean
- @ConfigurationProperties
- @Value
- properties file
- YAML file
- test linkage
- ambiguous bean
- unresolved runtime case

---

## 64. Negative fixtures

Critical negative cases:

- multiple beans of same type without qualifier
- dynamic route expression
- property expression not statically resolvable
- Kafka topic computed dynamically
- self-invoked transactional method
- ambiguous JPA relation target
- test imports package but not target
- unrelated config key

Do not create false exact relations.

---

## 65. Large enterprise class test

Use a large service/controller/entity set.

Verify enterprise semantics add only relevant context.

No whole-class dump.

---

## 66. Context budget sweep

Run:

```text
256
512
1024
2048
4096
8192
```

Measure:

- required-fact recall
- enterprise fact recall
- minimum sufficient budget
- context inflation

---

## 67. Context reduction guardrail

Enterprise semantics may increase context modestly.

That is acceptable only if recovered facts justify it.

Report:

```text
baseline context tokens
v1.4 context tokens
delta
facts recovered
```

per task.

---

## 68. Performance

Measure:

- cold Java enterprise indexing
- warm indexing
- single-file refresh
- preview latency
- semantic relation extraction time

Do not optimize prematurely.

---

## 69. Cache

If enterprise relation metadata is persisted:

- bump schema safely
- rebuild incompatible older caches
- preserve upgrade behavior

If derived on demand, avoid unnecessary schema churn.

---

## 70. MCP

The existing MCP tools must expose enterprise-aware context without new framework-specific tool names.

Do not add:

```text
spring.route
jpa.entity
kafka.topic
```

as separate MCP APIs in v1.4.

Use existing context tools.

---

## 71. CLI

Existing commands remain:

```bash
context-slice init
context-slice status
context-slice doctor
context-slice preview
context-slice mcp
```

Optional verbose diagnostics may report enterprise relation counts.

---

## 72. Diagnostics

Add detailed diagnostics such as:

```text
spring_routes
transaction_boundaries
event_handlers
scheduled_methods
jpa_entities
jpa_relations
repositories
kafka_producers
kafka_consumers
config_properties
test_links
enterprise_unresolved_relations
```

Keep normal output concise.

---

## 73. Clean-room enterprise smoke test

From packaged tarball:

1. fresh Spring project
2. `context-slice init`
3. `context-slice preview "explain <enterprise task>"`
4. verify route/service/repository/config relation where applicable
5. start MCP
6. invoke same task through MCP
7. repository remains clean

---

## 74. Packaging regression

Run:

- build
- all tests
- Java benchmark
- TypeScript benchmark
- npm pack
- isolated install
- Java enterprise smoke

Do not regress package guarantees.

---

## 75. README

Update README with enterprise support wording only if validated.

Example:

> ContextSlice understands selected static Java enterprise relationships such as Spring MVC routes, transaction boundaries, JPA repositories/entities, messaging links, configuration properties, and test references.

Do not say:

> understands Spring runtime

---

## 76. Documentation

Add:

```text
docs/java-enterprise-context.md
```

Cover:

- supported Spring semantics
- route handling
- DI boundaries
- transactions
- events/async/scheduled
- JPA/Spring Data
- Kafka
- configuration
- test linkage
- static-analysis limitations
- no Spring runtime/JDT dependency

---

## 77. Version

Target:

```text
1.4.0
```

if this is the next Java enterprise feature release.

Do not publish/tag/push automatically.

---

## 78. Benchmark report

Generate:

```text
benchmarks/results/v1.4-java-enterprise-context.md
benchmarks/results/v1.4-java-enterprise-context.json
```

Include:

1. baseline
2. architecture
3. semantic families
4. real repositories
5. task corpus
6. required-fact recall
7. retrieval recall
8. route metrics
9. transaction metrics
10. JPA/repository metrics
11. messaging metrics
12. config metrics
13. test linkage metrics
14. context reduction
15. enterprise context cost
16. minimum sufficient budget
17. false semantic edges
18. failure attribution
19. Java regression
20. TypeScript regression
21. JDT/LSP decision
22. known limitations
23. next step

---

## 79. Mandatory comparison table

Include:

```text
| Metric | Pre-v1.4 Java baseline | v1.4 | Delta |
|--------|-------------------------|------|-------|
| Required-fact recall | 100% | ... | ... |
| Retrieval recall | 100% | ... | ... |
| Median context reduction | ... | ... | ... |
| Whole-file fallback | ... | ... | ... |
| Route linkage recall | N/A | ... | ... |
| JPA relation recall | N/A | ... | ... |
| Kafka linkage recall | N/A | ... | ... |
| Property linkage recall | N/A | ... | ... |
| Test linkage recall | N/A | ... | ... |
| Enterprise false-positive edges | N/A | ... | ... |
```

---

## 80. Per-family evidence table

Also include:

```text
| Semantic family | Facts recovered | Extra tokens | False edges | Keep/Remove |
|-----------------|-----------------|--------------|-------------|-------------|
| Spring MVC | ... | ... | ... | ... |
| Transactions/events | ... | ... | ... | ... |
| JPA/Spring Data | ... | ... | ... | ... |
| Kafka | ... | ... | ... | ... |
| Config/property | ... | ... | ... | ... |
| Test linkage | ... | ... | ... | ... |
```

This table is mandatory.

---

## 81. Feature removal discipline

If a semantic family:

- recovers zero real-task facts,
- does not reduce fallback,
- does not lower minimum sufficient budget,
- and adds context or complexity,

remove it from production or leave it explicitly experimental.

Targeted fixture correctness alone is not enough to justify permanent production complexity.

---

## 82. Release blocker conditions

v1.4 must not be marked GO if:

- Java recall regresses
- TypeScript recall regresses
- false exact enterprise edges are introduced systematically
- whole-file/class fallback becomes common
- enterprise semantics materially inflate context without fact benefit
- framework-specific hacks leak into core
- package/runtime regressions appear

---

## 83. Definition of done

v1.4 is complete when:

- all existing tests pass
- Java baseline replayed
- TypeScript regression passes
- enterprise fixture corpus passes
- Spring MVC routes extracted
- DI edges extracted conservatively
- transaction boundaries extracted
- async/event/scheduled metadata extracted
- Spring Data repository semantics extracted
- JPA entity relations extracted
- Kafka producer/consumer relations extracted where deterministic
- config/property relations extracted where deterministic
- test linkage measured
- real enterprise repos benchmarked
- required-fact recall reported
- retrieval recall reported
- enterprise-specific recall/precision reported
- false enterprise edges reported
- context cost reported
- minimum sufficient budget reported
- per-family keep/remove decision made
- no benchmark leakage
- no repo-specific hacks
- no JDT/LSP without evidence
- packaging clean-room smoke passes
- docs updated
- benchmark report generated

---

## 84. Final implementation report

At completion output:

```text
STATUS

VERSION

BUILD / TESTS

JAVA BASELINE

TYPESCRIPT REGRESSION

ENTERPRISE ARCHITECTURE

SPRING MVC

DEPENDENCY INJECTION

TRANSACTIONS

ASYNC / EVENTS / SCHEDULED

SPRING DATA

JPA RELATIONS

KAFKA / MESSAGING

CONFIG / PROPERTIES

TEST LINKAGE

REQUIRED-FACT RECALL

RETRIEVAL RECALL

ENTERPRISE RECALL / PRECISION

FALSE ENTERPRISE EDGES

CONTEXT REDUCTION

ENTERPRISE CONTEXT COST

MINIMUM SUFFICIENT BUDGET

PER-FAMILY FACT RECOVERY

PER-FAMILY KEEP / REMOVE

FAILURE ATTRIBUTION

PERFORMANCE

CACHE

PACKAGING

CLEAN-ROOM ENTERPRISE TEST

JDT / LSP DECISION

KNOWN LIMITATIONS

NEXT STEP
```

Every metric must state benchmark scope.

---

## 85. Guiding principle

The central question for v1.4 is:

> Can ContextSlice recover the enterprise semantics that Java developers normally have to reconstruct manually across controllers, services, repositories, entities, messaging, configuration, and tests — while still sending only minimum sufficient context to the coding assistant?

Prefer static evidence.

Prefer fewer, high-value semantics over broad framework imitation.

Benchmark every semantic family before keeping it.
