# ContextSlice

MCP server cục bộ cho Java, giúp coding agent truy xuất context theo symbol thay vì đọc toàn bộ file.

## Chạy

```sh
npm install
npm run build
npm start
```

Server dùng stdio. Có thể cấu hình trong `.vscode/mcp.json`. Đặt `CONTEXT_SLICE_ROOT` nếu chạy server với repository khác.

Năm tool được cung cấp: `context.search`, `context.symbol`, `context.callers`, `context.slice`, `context.diff`.

## Validation v0.2

Benchmark v0.2 được định nghĩa trong `benchmarks/tasks.json` và sinh `benchmarks/results/latest.md` cùng dữ liệu JSON tương ứng. Mỗi task đo required-fact recall, context efficiency, các budget từ 256 đến 8192 token, minimum sufficient budget, unresolved-call rate và cold/warm cache metrics.

Kết quả 48.89% trước đây chỉ là fixture `retryPayment` của v0.1, không phải tuyên bố chung cho sản phẩm. Token reduction chỉ có ý nghĩa khi required-fact recall vẫn đạt 100%; agent baseline không được báo cáo nếu runtime không cung cấp telemetry.

Validation hiện tại có fixture nhỏ và failure corpus cho các giới hạn Tree-sitter như overload, interface dispatch, chained calls và unresolved receiver. Việc benchmark trên ba repository Java/Spring thực tế cần checkout các repository bên ngoài và chưa được giả lập trong report. Dữ liệu hiện tại chưa đủ để biện minh cho JDT/LSP; quyết định v0.3 phải dựa trên unresolved-call rate và số required facts bị mất trong các repository thực tế.

## Validation v0.3

V0.3 đánh giá ba scope Java được pin bằng commit: Spring Petclinic (small), Petclinic REST (medium) và module `services` của Keycloak (large). Checkout nằm trong `benchmarks/checkouts/` và bị loại khỏi Git; cấu hình URL, SHA, scope nằm trong [benchmarks/repositories.json](benchmarks/repositories.json). Chạy `npm run benchmark:v03` để sinh [benchmarks/results/v0.3-real-repositories.md](benchmarks/results/v0.3-real-repositories.md) và JSON tương ứng.

Runner có 15 task grounded độc lập trong [benchmarks/tasks.json](benchmarks/tasks.json), budget sweep 256-8192, required-fact recall, attribution (`PARSER`, `SYMBOL_INDEX`, `CALL_RESOLUTION`, `RANKING`, `TOKEN_BUDGET`), unresolved/ambiguous call rate, cold/warm/single-file cache metrics và resolution harm. Agent telemetry được ghi `N/A` khi runtime không cung cấp.

Kết quả v0.3 hiện tại: 15 task, required-fact recall 93.94%, median token reduction 95.05%, resolution harm 0%, resolution fact-loss 0%. Một task bị unsatisfied do `SYMBOL_INDEX`; đây là failure được giữ lại trong aggregate, không bị loại. Các con số này chỉ áp dụng cho ba commit/scope đã ghi ở trên, không phải cam kết tổng quát.

## Validation v0.4

V0.4 harden symbol identity và lookup trước khi cân nhắc JDT/LSP. ID canonical có dạng `package::enclosing-type-chain::kind::name(parameter-signature)`, nên overload, nested type và cùng tên ở package khác nhau giữ được identity riêng. Lookup chấp nhận stable ID, canonical/qualified name, signature và simple-name ambiguity; ranking có tie-break deterministic. SQLite schema được version `0.4` và tự rebuild khi gặp cache cũ.

Chạy `npm run benchmark:v04` để chạy lại 15 task v0.3 rồi sinh [benchmarks/results/v0.4-symbol-index-hardening.md](benchmarks/results/v0.4-symbol-index-hardening.md). Stress corpus nằm trong `tests/fixtures/symbol-index/`, với test cho package duplicate, overload, constructor, nested type, record, enum, interface và stable ID.

Kết quả v0.4 trên ba commit đã pin: retrieval recall `100%` (15/15 target), symbol-index failure rate `0%`, symbol fact loss rate `0%`, required-fact recall `100%`. Median token reduction của rerun là `95.05%`; unresolved call và inherited/anonymous semantic behavior vẫn là giới hạn riêng, chưa biện minh cho JDT/LSP.

## Kiểm tra

```sh
npm test
npm run benchmark
```
