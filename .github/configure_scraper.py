"""
Pre-deploy script: checks if the kanbanflow-scraper worker exists in the
Cloudflare account and removes the 'services' binding from wrangler.jsonc
if it does not. This allows the app to deploy regardless of whether the
scraper worker is present.

Expects CLOUDFLARE_API_TOKEN to be set in the environment.
"""
import json
import os
import sys
import urllib.error
import urllib.request


def cf_get(token, path):
    headers = {"Authorization": f"Bearer {token}"}
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4{path}", headers=headers
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def main():
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not token:
        print("ERROR: CLOUDFLARE_API_TOKEN is not set.", file=sys.stderr)
        sys.exit(1)

    # Resolve account ID via /user/memberships.
    # This works with any account-scoped Workers token (no extra permissions needed).
    try:
        resp = cf_get(token, "/user/memberships?status=accepted&per_page=50")
        accounts = [m["account"] for m in resp.get("result", [])]
    except urllib.error.HTTPError as e:
        # Token may not have Memberships Read — skip check, deploy without scraper.
        print(
            f"WARNING: Could not list memberships (HTTP {e.code}). "
            "Deploying without SCRAPER binding."
        )
        strip_scraper_binding()
        return

    if len(accounts) == 0:
        print(
            "WARNING: No account memberships found for this token. "
            "Deploying without SCRAPER binding."
        )
        strip_scraper_binding()
        return

    if len(accounts) > 1:
        names = ", ".join(a["name"] for a in accounts)
        print(
            f"ERROR: API token is scoped to multiple accounts ({names}). "
            "Add a CLOUDFLARE_ACCOUNT_ID secret and update the workflow.",
            file=sys.stderr,
        )
        sys.exit(1)

    account_id = accounts[0]["id"]

    # Check whether the kanbanflow-scraper worker exists (list endpoint returns JSON).
    resp = cf_get(token, f"/accounts/{account_id}/workers/scripts?per_page=50")
    script_ids = {s["id"] for s in resp.get("result", []) if s.get("id")}
    if "kanbanflow-scraper" in script_ids:
        print("kanbanflow-scraper found — deploying with SCRAPER service binding.")
    else:
        print(
            "kanbanflow-scraper not found — removing SCRAPER service binding for this deploy."
        )
        strip_scraper_binding()


def strip_scraper_binding():
    with open("wrangler.jsonc") as f:
        config = json.load(f)
    config.pop("services", None)
    with open("wrangler.jsonc", "w") as f:
        json.dump(config, f, indent="\t")
        f.write("\n")


if __name__ == "__main__":
    main()
