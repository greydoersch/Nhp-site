# Polar Estimator: estimating module

Module 1 of the Construction Agent Build Plan. A phone-first web app: describe a job, add measurements and site photos, and get a **draft** estimate priced from your own price sheet. Edit it, approve it, and save it as a PDF quote.

## How it works

1. The phone resizes the photos and sends them to `/api/estimate` (`netlify/functions/estimate.mjs`) with the description, the measurements and the price-sheet **codes and units**. Prices are never sent.
2. Claude (`claude-opus-5-5`, structured JSON output) chooses which price-sheet items apply and how many, and shows its work for each quantity. It also lists assumptions, questions for you and site risks it saw in the photos.
3. The app prices every line from your sheet (`estimator/pricing.js`, whole-cent math). Codes not on the sheet are dropped. Work that the sheet doesn't cover comes back as a highlighted custom item, and you must set its price before you can approve.
4. Until you press **Approve prices**, the estimate stays a draft, and its PDF is stamped "DRAFT – NOT FOR CUSTOMER".

Estimates, the price sheet and settings are saved on the phone (localStorage) for now. Shared crew storage and logins come with Supabase.

## Deploy on Netlify

1. Create a new Netlify site from this repo. `netlify.toml` already sets the publish folder, the functions and a redirect from `/` to `/estimator/`.
2. Under **Site settings → Environment variables**, add:
   - `ANTHROPIC_API_KEY`: your Anthropic API key
   - `ESTIMATOR_ACCESS_CODE`: any passphrase. Crew members enter it in the app's Settings tab. It keeps strangers from running up your API bill until real logins exist.
3. Deploy. On the phone, open the site and choose "Add to Home Screen".

AI drafts take roughly 15–60 seconds. Netlify's default function timeout is 10 seconds. If drafts time out, raise the function timeout in the Netlify UI (paid plans allow up to 26 seconds), or switch `effort` in `estimate.mjs` from `"medium"` to `"low"`.

## Your price sheet

`estimator/prices.json` holds **placeholder** Alaska septic, site and landscaping prices. Replace them by editing prices on the app's Prices tab, by importing a JSON file, or by editing `prices.json` and redeploying (set `"placeholder": false`). An item needs a `code`, `name`, `unit` and `price`. The AI picks items by their names, so make the names clear.

## Develop

```
npm install
npm test          # pricing tests
npx netlify dev   # app + function at http://localhost:8888
```
