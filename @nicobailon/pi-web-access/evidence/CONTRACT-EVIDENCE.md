# SERPdive API — contract evidence

Every block below is a real call against `https://api.serpdive.com/v1/search`, captured on 2026-07-25. Reproduce any of them with your own key: the script that
generated this file is `evidence/contract-probe.mjs`. Page content is truncated to keep the file
readable — nothing else is edited, and the API key is redacted.

---

## 1. Default request and response shape

### Query only

The whole request surface is `query`, `model`, `answer`, `max_results`. Everything else is ignored.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases"}
```

`HTTP 200` in 2059 ms

```json
{
  "query": "best open source vector databases",
  "model": "mako",
  "response_time_ms": 1906,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (431 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "Chroma prioritizes simplicity and developer experience, particularly for Python workflows.… (90 chars)"
    },
    "… 5 more, same shape"
  ]
}
```

## 2. Models

### krill — free tier

No answer synthesis on this tier: requesting one is ignored rather than refused (see §3).

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill"}
```

`HTTP 200` in 2145 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 2113,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (213 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (190 chars)"
    },
    "… 3 more, same shape"
  ]
}
```

### mako — 1 credit

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"mako"}
```

`HTTP 200` in 1976 ms

```json
{
  "query": "best open source vector databases",
  "model": "mako",
  "response_time_ms": 1941,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (713 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (457 chars)"
    },
    "… 3 more, same shape"
  ]
}
```

### moby — 1.5 credits

Full readable page content; note the content lengths against mako above.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"moby"}
```

`HTTP 200` in 2647 ms

```json
{
  "query": "best open source vector databases",
  "model": "moby",
  "response_time_ms": 2561,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (14041 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "Serve your agents fresh data at Redis speed.\nComparing the best open source vector databas… (13856 chars)"
    },
    "… 4 more, same shape"
  ]
}
```

## 3. `answer`

### answer: true with mako

The `answer` key is present only when requested.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"mako","answer":true}
```

`HTTP 200` in 2490 ms

```json
{
  "query": "best open source vector databases",
  "model": "mako",
  "response_time_ms": 2456,
  "answer": "The best open source vector databases are: \n1. Opensearch \n2. Apache Cassandra \n3. pgvector \n4. Milvus \n5. Qdrant \n6. Weaviate \n7. Vald.… (136 chars)",
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (529 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (591 chars)"
    },
    "… 3 more, same shape"
  ]
}
```

### answer: true with krill

Silently ignored on the free tier — no `answer` key, no error, still a complete result.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","answer":true}
```

`HTTP 200` in 1642 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1612,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (322 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (293 chars)"
    },
    "… 2 more, same shape"
  ]
}
```

## 4. `max_results` is a cap, never a minimum

A cap, applied at the edge after the search. The engine still reads a full corpus, so a small
cap trims the response, not the work — and asking for more does not produce more.

### max_results: 1

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":1}
```

`HTTP 200` in 1697 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1665,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (213 chars)"
    }
  ]
}
```

### max_results: 3

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":3}
```

`HTTP 200` in 1725 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1681,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (634 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "Some vector databases work best with Kubernetes orchestration, while others offer cloud-ho… (182 chars)"
    },
    "… 1 more, same shape"
  ]
}
```

### max_results: 10

The ceiling of the range. Fewer come back when fewer are judged relevant — see §1, where no cap returned 5.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":10}
```

`HTTP 200` in 1706 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1676,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (502 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (97 chars)"
    },
    "… 5 more, same shape"
  ]
}
```

### max_results: 50

Above the range: clamped down to 10, silently. Never a 400.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":50}
```

`HTTP 200` in 1820 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1788,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (213 chars)"
    },
    {
      "url": "https://redis.io/blog/best-open-source-vector-databases-comparison/",
      "title": "Comparing the best open source vector databases (2026)",
      "content": "This comparison breaks down the leading open source vector databases for production AI wor… (247 chars)"
    },
    "… 3 more, same shape"
  ]
}
```

### max_results: 0

Below the range: clamped UP to 1, silently — it is the minimum of the range, NOT a way to say "no cap". One result comes back.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":0}
```

`HTTP 200` in 1845 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 1800,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (322 chars)"
    }
  ]
}
```

### max_results: "abc"

Unparseable, and this is the asymmetry worth knowing: an out-of-range NUMBER is clamped into the range, but a value that is not a number at all drops the cap entirely and the default applies. Same for null or an absent field.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill","max_results":"abc"}
```

`HTTP 200` in 2096 ms

```json
{
  "query": "best open source vector databases",
  "model": "krill",
  "response_time_ms": 2014,
  "results": [
    {
      "url": "https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026/",
      "title": "Best open source vector database solutions: Top 5 in 2026",
      "content": "Notable open source vector database solutions · 1. Opensearch · 2. Apache Cassandra · 3. p… (520 chars)"
    },
    {
      "url": "https://medium.com/@pratik-rupareliya/top-15-vector-databases-in-2026-a-production-decision-guide-from-100-enterprise-deployments-dd58a04f51a5",
      "title": "Medium",
      "content": "Top 15 vector databases in 2026: A production decision guide from 100+ enterprise deployme… (408 chars)"
    },
    "… 4 more, same shape"
  ]
}
```

## 5. Errors

### Missing query

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"model":"krill"}
```

`HTTP 400` in 39 ms

```json
{
  "error": "missing_query",
  "message": "The \"query\" field is required, e.g. {\"query\": \"your search\"}."
}
```

### Invalid key

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_not_a_real_key
content-type: application/json

{"query":"best open source vector databases"}
```

`HTTP 401` in 533 ms

```json
{
  "error": "invalid_api_key",
  "message": "This API key is invalid or was revoked. Manage your keys at https://serpdive.com/dashboard/keys"
}
```

### No key at all

```http
POST https://api.serpdive.com/v1/search
(no authorization header sent)
content-type: application/json

{"query":"best open source vector databases"}
```

`HTTP 401` in 27 ms

```json
{
  "error": "missing_api_key",
  "message": "No API key. Send it as \"Authorization: Bearer sd_live_…\" — create one at https://serpdive.com/dashboard/keys"
}
```

## 6. Abort

### Client aborts mid-flight

The request is cancellable at any point; the provider maps this to the framework abort path.

```http
POST https://api.serpdive.com/v1/search
authorization: Bearer sd_live_…            # a valid key, redacted
content-type: application/json

{"query":"best open source vector databases","model":"krill"}
```

Client aborted after 300 ms → `AbortError` raised locally; no response body.
