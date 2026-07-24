# Setup — keeping your API key off the client

## 1. Revoke the keys you already pasted in chat
Go to https://platform.openai.com/api-keys and delete all 10 you shared earlier.
They should be treated as burned even though I never used them.

## 2. Generate one new key
Same page → "Create new secret key". Copy it once (OpenAI only shows it that one time).
Optionally set a monthly spend cap under Settings → Limits, as a safety net.

## 3. Deploy this folder to Netlify
- Drag this whole `forex-sim` folder into https://app.netlify.com/drop, or
- Push it to a GitHub repo and connect it in the Netlify dashboard.

Either way, Netlify will see `netlify.toml` and automatically pick up
`netlify/functions/ai-interpret.js` as a serverless function.

## 4. Add the key as an environment variable (NOT in any file)
In the Netlify dashboard: **Site settings → Environment variables → Add a variable**
- Key: `OPENAI_API_KEYS`
- Value: your new key (or several, comma-separated, if you want basic rotation
  across multiple accounts to raise your effective rate limit)

Redeploy after adding the variable (Netlify → Deploys → Trigger deploy).

## How it works now
- `index.html` calls `/.netlify/functions/ai-interpret` — a same-origin path,
  no key involved.
- `ai-interpret.js` runs on Netlify's servers, reads `OPENAI_API_KEYS` from
  its environment, and makes the real OpenAI call from there.
- Anyone who views your page source or opens dev tools sees nothing but that
  same-origin function path — the key itself never reaches the browser.

## Local testing (optional)
If you want to test before deploying:
```
npm install -g netlify-cli
netlify dev
```
This runs the function locally too — create a `.env` file (not committed,
not part of this bundle) with `OPENAI_API_KEYS=sk-...` for local runs.
