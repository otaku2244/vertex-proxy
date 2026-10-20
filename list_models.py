"""列出 Vertex AI 各 location 可用的 Gemini 模型（排查模型名/区域可用性用）。

用法：
    GCP_PROJECT=your-project-id python3 list_models.py
"""
import json
import os
import sys
import urllib.request
import urllib.parse

ADC = os.environ.get(
    "ADC_PATH",
    os.path.join(os.path.expanduser("~"), ".config/gcloud/application_default_credentials.json"),
)
PROJECT = os.environ.get("GCP_PROJECT", "")

if not PROJECT:
    sys.exit("GCP_PROJECT is required (env GCP_PROJECT=your-project-id)")

adc = json.load(open(ADC))
data = urllib.parse.urlencode({
    "client_id": adc["client_id"],
    "client_secret": adc["client_secret"],
    "refresh_token": adc["refresh_token"],
    "grant_type": "refresh_token",
}).encode()
tok = json.load(urllib.request.urlopen(
    "https://oauth2.googleapis.com/token", data))["access_token"]

for loc in ["global", "us-central1", "us-east5"]:
    host = "aiplatform.googleapis.com" if loc == "global" else "%s-aiplatform.googleapis.com" % loc
    url = ("https://%s/v1/projects/%s/locations/%s/"
           "publishers/google/models?pageSize=1000" % (host, PROJECT, loc))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    try:
        j = json.load(urllib.request.urlopen(req, timeout=40))
        names = sorted(m["name"].split("/")[-1] for m in j.get("models", []))
        print("=== %s total=%d" % (loc, len(names)))
        hit = [n for n in names if n.startswith(("gemini-4", "gemini-3", "gemini-2.5"))]
        for n in hit:
            print("   ", n)
        if not hit:
            print("    (no gemini-2.5/3/4 series)")
    except Exception as e:
        print("=== %s ERR %s" % (loc, e))
