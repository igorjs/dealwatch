# Store Request Capture Guide

## Why Captures Are Needed

Coles and Woolworths sit behind bot protection: Coles guards its API with a
subscription key and Incapsula cookies; Woolworths uses a JWT token and Akamai
bot cookies. Each fetcher needs a captured request profile (URL, headers, and
cookies) to simulate a real browser request. Aldi offers a clean public API with
no authentication required.

## How to Capture Per Store

Use your browser's DevTools Network tab to capture one real request per store.
On the Network tab, use "Copy as cURL" to grab the exact headers and cookies.

### Woolworths

1. Navigate to https://www.woolworths.com.au/shop/browse/specials/half-price.
2. Open DevTools (F12) → Network tab → filter by XHR/Fetch.
3. Scroll or wait for the page to load deals.
4. Look for a POST request to `/apis/ui/browse/category`.
5. Click it and check the Request payload: you should see
   `categoryId: "specialsgroup.3676"` (the Half Price group).
6. Copy the entire request (right-click → Copy as cURL).
7. Also open the Response tab and copy the JSON response body.

Save both:

- The cURL command → extract the Authorization header (the `wow-auth-token` JWT)
  and Akamai cookies (`_abck`, `bm_sz`, `ak_bmsc`, `bm_sv`) into
  `config.local.json` under the Woolworths store profile (see "Where Captures
  Go" below).
- The response JSON → save as a trimmed sample to
  `test/fixtures/woolworths.json`.

**Note:** The Woolworths JWT expires in roughly 1 hour. Expect to re-capture
this profile frequently.

### Coles

1. Navigate to https://www.coles.com.au/on-special?filter_Special=halfprice.
2. Open DevTools (F12) → Network tab → filter by XHR/Fetch.
3. Scroll or wait for deals to load.
4. Look for a POST request to `/api/graphql`.
5. Click it and check the Request payload: find the `operationName` field. You
   need the **product listing operation** (NOT GetProductCategories). It should
   have variables like `limit`, `offset`, or `pageNumber`.
6. Copy the entire request (right-click → Copy as cURL).
7. Also open the Response tab and copy the JSON response body.

Save both:

- The cURL command → extract the `ocp-apim-subscription-key` header and the
  Incapsula session cookies (including `reese84`) into `config.local.json` under
  the Coles store profile.
- The response JSON → save as a trimmed sample to `test/fixtures/coles.json`.

### Aldi

Aldi requires no capture. The API is public:

```
GET https://api.aldi.com.au/v3/product-search?currency=AUD&serviceType=walk-in&categoryKey=<key>&limit=30&offset=0&sort=relevance&servicePoint=<store>
```

The two specials categories are:

- Super Savers: `categoryKey=1588161426952145`
- Limited Time Only: `categoryKey=1588161420755352`

No auth headers or cookies needed. The `servicePoint` selects an Aldi store
(e.g., `G452`); this is your local store choice and goes in config, not in a
secret.

To collect a fixture:

1. Make one GET request to each category (or use curl in a terminal).
2. Merge the two responses into one `test/fixtures/aldi.json` with a combined
   products array.

## Where Captures Go

**Secrets (cookies, subscription key, JWTs)** → the gitignored
`config.local.json` file, under each store's `storeProfile` section. Example:

```json
{
  "stores": {
    "woolworths": {
      "url": "https://www.woolworths.com.au/apis/ui/browse/category",
      "headers": {
        "Authorization": "Bearer <wow-auth-token>",
        "Cookie": "_abck=...; bm_sz=...; ak_bmsc=...; bm_sv=..."
      }
    },
    "coles": {
      "url": "https://www.coles.com.au/api/graphql",
      "headers": {
        "ocp-apim-subscription-key": "<key>",
        "Cookie": "reese84=...; ..."
      }
    },
    "aldi": {
      "servicePoint": "G452",
      "categoryKeys": ["1588161426952145", "1588161420755352"]
    }
  }
}
```

Never commit real cookies or keys. Treat any capture shared in chat as exposed;
re-capture fresh.

**Trimmed sample response JSON** → `test/fixtures/<store>.json`. Keep only
enough fields for the parser tests to validate the structure. Remove bulk items
if needed to keep the file small.

## Refreshing Captures

**Woolworths:** Token expires in roughly 1 hour. The pipeline backs off after
failures (hourly retry instead of every 20 minutes), so a stale profile will not
hammer the endpoint. Re-capture when you see failures in the logs.

**Coles:** Session material (cookies) may expire. If requests start failing
after the profile works once, re-capture fresh.

**Aldi:** No session or token. This profile is stable and requires no refresh.

## Security Warning

Never commit real cookies, subscription keys, or JWTs to the repository. Any
capture material shared in a chat, email, or issue must be treated as exposed.
Re-capture fresh credentials before using them in production. Store all secrets
in the gitignored `config.local.json` file only.
