"""Generate the Support Signal demo dataset.

A fictional B2B SaaS company, Larkspur (workforce scheduling software), with
twelve months of support cases. Every flaw is planted on purpose and listed in
data/DATASHEET.md with the verdict it should trigger. Nothing here is derived
from any real company's data.

Run: python3 generator/generate_demo.py   (fixed seed, so output is identical every run)
"""
import csv
import json
import math
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

SEED = 20261001
rng = np.random.default_rng(SEED)
OUT = Path(__file__).resolve().parent.parent / "data"
OUT.mkdir(exist_ok=True)

START = datetime(2025, 10, 1)
END = datetime(2026, 9, 30, 18, 0)
HISTORY_START = datetime(2026, 1, 12)  # field history switched on here
N_ACCOUNTS = 900

PRODUCTS = ["Rota", "Timesheets", "Payroll Connect"]
PRODUCT_P = [0.5, 0.3, 0.2]
SIZES = ["Small", "Mid", "Enterprise"]
SIZE_P = [0.55, 0.33, 0.12]
RATE_PRODUCT = {"Rota": 3.6, "Timesheets": 4.8, "Payroll Connect": 10.5}
RATE_SIZE = {"Small": 0.7, "Mid": 1.2, "Enterprise": 2.0}

# Customer needs (the true theme of each case). weight per product, typical days, complexity
THEMES = {
    "Login issue":                 dict(w=(8, 6, 5), days=0.6, cx=0.1, subj=["Can't log in to Larkspur", "Login keeps failing for our managers", "Locked out after password change"]),
    "Password reset":              dict(w=(7, 6, 4), days=0.3, cx=0.0, subj=["Need a password reset for a staff member", "Password reset email not arriving"]),
    "SSO":                         dict(w=(3, 3, 3), days=2.5, cx=0.4, subj=["SSO login stopped working with Azure AD", "Single sign-on redirect loop for all users"]),
    "Add users":                   dict(w=(8, 6, 4), days=0.4, cx=0.0, subj=["How do I add new starters to the rota", "Bulk add 40 users from a spreadsheet"]),
    "Rota publishing":             dict(w=(10, 2, 2), days=1.2, cx=0.2, subj=["Published rota not showing for staff", "Rota changes not saving before publish"]),
    "Shift swap not working":      dict(w=(8, 1, 1), days=1.5, cx=0.3, subj=["Shift swap requests stuck pending", "Staff can't swap shifts in the app"]),
    "Notifications not received":  dict(w=(6, 4, 3), days=1.8, cx=0.3, subj=["Staff not getting shift notifications", "Push notifications stopped on Android"]),
    "Timesheet approval":          dict(w=(1, 10, 4), days=1.0, cx=0.2, subj=["Managers can't approve timesheets", "Approved timesheets reverting to draft"]),
    "Clock-in error":              dict(w=(2, 9, 2), days=1.4, cx=0.3, subj=["Clock-in error at the Leeds site", "Geofence blocking clock-in for remote staff"]),
    "Export to payroll failed":    dict(w=(0, 3, 14), days=6.0, cx=0.8, subj=["Payroll export failed this morning", "Export to Sage payroll missing overtime hours"]),
    "Payroll mapping":             dict(w=(0, 2, 10), days=7.0, cx=0.8, subj=["Pay codes mapping wrong in payroll file", "Holiday pay mapped to wrong code in export"]),
    "API error":                   dict(w=(1, 2, 7), days=8.0, cx=0.9, subj=["API returning 500 on shifts endpoint", "Webhook payload missing employee ID"]),
    "Billing question":            dict(w=(6, 5, 5), days=0.8, cx=0.1, subj=["Question about our latest invoice", "Why did our bill go up this month"]),
    "Invoice copy":                dict(w=(4, 3, 3), days=0.3, cx=0.0, subj=["Please send a copy of invoice for March", "Need VAT invoice for finance"]),
    "Mobile app crash":            dict(w=(5, 4, 2), days=3.0, cx=0.5, subj=["App crashes when opening the rota", "iOS app closes on login"]),
    "Report request":              dict(w=(4, 4, 3), days=1.0, cx=0.1, subj=["How do I report on hours by site", "Need a labour cost report by week"]),
    "Data import":                 dict(w=(3, 3, 4), days=2.0, cx=0.4, subj=["Import of staff list failing on row 12", "CSV import ignoring contract hours"]),
    "Cancel subscription":         dict(w=(2, 2, 2), days=1.0, cx=0.1, subj=["We'd like to cancel our subscription", "Notice to end our contract"]),
}
THEME_NAMES = list(THEMES)
RARE_REASONS = ["GDPR request", "Holiday accrual", "Custom field", "Branding", "Webhook"]
DUP_LABELS = {"Login issue": "Login Issues", "SSO": "Single sign-on"}  # near-duplicate reason labels
JUNK_SUBJECTS = ["Help", "Urgent", "", "Question", "Re: ", "Issue"]
GROUPS_FIRST = ["Frontline UK", "Frontline UK", "Frontline UK", "Frontline IE"]
GROUPS_LATER = ["Product Specialists", "Payroll Team", "Engineering"]
AGENTS = [f"Agent {c}" for c in "ABCDEFGHIJKLMNOPQRSTUV"]
NOTE_TEMPLATES = ["Walked customer through settings; resolved.", "Reset credentials and confirmed access.",
                  "Fixed mapping in admin and re-ran export.", "Bug logged with engineering; workaround given.",
                  "Sent article and confirmed customer happy.", "Corrected data and re-published rota."]
ARTICLES = [f"KB-{n}" for n in range(101, 160)]


def pick(seq, p=None):
    return seq[rng.choice(len(seq), p=p)]


def iso(d):
    return d.strftime("%Y-%m-%d %H:%M") if d else ""


accounts = []
for i in range(N_ACCOUNTS):
    product = pick(PRODUCTS, PRODUCT_P)
    size = pick(SIZES, SIZE_P)
    accounts.append(dict(id=f"ACC-{i+1:04d}", product=product, size=size,
                         n=int(rng.poisson(RATE_PRODUCT[product] * RATE_SIZE[size]))))

cases, history = [], []
seq = 10000
for a in accounts:
    pidx = PRODUCTS.index(a["product"])
    w = np.array([THEMES[t]["w"][pidx] for t in THEME_NAMES], float)
    w /= w.sum()
    acc_cases = []
    for _ in range(a["n"]):
        seq += 1
        theme = THEME_NAMES[rng.choice(len(THEME_NAMES), p=w)]
        T = THEMES[theme]
        created = START + timedelta(minutes=int(rng.integers(0, int((END - START).total_seconds() // 60) - 60 * 24 * 3)))
        # ownership: complexity drives handoffs
        owners = 1 + int(rng.poisson(0.35 + 1.6 * T["cx"]))
        eng = owners >= 2 and rng.random() < 0.25 + 0.5 * T["cx"]
        days = float(rng.lognormal(math.log(T["days"]), 0.9)) * (1 + 0.6 * (owners - 1))
        if eng:
            days *= 2.2
        closed = created + timedelta(days=days)
        status = "Solved"
        if closed > END:
            closed, status = None, pick(["Open", "Pending", "On-hold"])
        acc_cases.append(dict(seq=seq, theme=theme, created=created, closed=closed, status=status,
                              owners=owners, eng=eng, days=days))
    # genuine service effect: an account with a slow AND passed-around case is more likely to churn
    slow_passed = any(c["closed"] is not None and c["days"] > 30 and c["owners"] >= 3 for c in acc_cases)
    logit = -2.7 + {"Rota": 0.0, "Timesheets": 0.35, "Payroll Connect": 1.25}[a["product"]] + 0.95 * slow_passed
    a["churned"] = bool(acc_cases) and rng.random() < 1 / (1 + math.exp(-logit))
    a["cases"] = acc_cases

channels, ch_p = ["Email", "Chat", "Phone", "Web form"], [0.55, 0.25, 0.15, 0.05]
for a in accounts:
    # churners often log an exit event in a case before leaving
    if a["churned"] and a["cases"] and rng.random() < 0.45:
        c = a["cases"][int(rng.integers(0, len(a["cases"])))]
        c["theme"], c["exit"] = "Cancel subscription", "Cancellation request"
    for c in a["cases"]:
        T = THEMES[c["theme"]]
        r = rng.random()
        if r < 0.24:
            reason = pick(["Other", "Other", "Other", "General", ""])  # catch-all swallows ~24%
        elif r < 0.37:
            reason = pick(["Tier 2", "Escalated to Engineering", "Billing team"])  # team-type reasons ~13%
        elif r < 0.372:
            reason = pick(RARE_REASONS)
        else:
            reason = c["theme"]
            if reason in DUP_LABELS and rng.random() < 0.4:
                reason = DUP_LABELS[reason]
        subject = pick(JUNK_SUBJECTS) if rng.random() < 0.12 else pick(T["subj"])
        description = "" if rng.random() < 0.2 else f"{pick(T['subj'])}. Affects {int(rng.integers(1, 40))} staff at our {pick(['London', 'Leeds', 'Dublin', 'Bristol', 'Glasgow'])} site."
        if subject.strip() and len(subject.split()) < 5 and description == "":
            pass
        first_group = pick(GROUPS_FIRST)
        groups = [first_group]
        if c["owners"] >= 2:
            groups.append("Engineering" if c["eng"] else pick(GROUPS_LATER[:2]))
        agents = list(rng.choice(AGENTS, size=min(c["owners"], len(AGENTS)), replace=False))
        closed = c["closed"]
        surveyed = closed is not None and rng.random() < (0.30 if c["days"] < 3 else 0.12)  # happier customers answer more
        if surveyed:
            base = 4.6 - 0.25 * (c["owners"] - 1) - (0.9 if c["days"] > 30 else 0.0) - (0.3 if c["eng"] else 0)
            csat = int(min(5, max(1, round(rng.normal(base, 0.7)))))
        else:
            csat = ""
        note = pick(NOTE_TEMPLATES) if closed is not None and rng.random() < 0.38 else ""
        article = pick(ARTICLES) if closed is not None and rng.random() < 0.12 else ""
        last_update = (closed or (END - timedelta(days=float(rng.exponential(9)))))
        if last_update < c["created"]:
            last_update = c["created"] + timedelta(hours=2)
        wait = int(c["days"] * 1440 * rng.uniform(0.1, 0.5)) if closed is not None else ""
        row = dict(
            case_id=f"LS-{c['seq']}", created_at=iso(c["created"]), closed_at=iso(closed), status=c["status"],
            owner=agents[-1], group=groups[-1], reason=reason, subject=subject, description=description,
            account_id=a["id"], account_size=a["size"], product=a["product"],
            channel=pick(channels, ch_p), priority=pick(["Low", "Normal", "High", "Urgent"], [0.2, 0.55, 0.2, 0.05]),
            escalated="Yes" if c["eng"] and rng.random() < 0.04 else "No",  # flag rarely set
            resolution_note=note, linked_article=article, last_update_at=iso(last_update),
            csat_score=csat, churned="Yes" if a["churned"] else "No", exit_event=c.get("exit", ""),
            # history-export-only columns
            reopens=int(rng.poisson(0.12)) if closed is not None else 0,
            assignee_stations=c["owners"], group_stations=len(groups), requester_wait_minutes=wait,
        )
        cases.append(row)
        # change log, only for changes after tracking was switched on
        t = c["created"]
        step = (closed or END) - t
        changes = []
        for k in range(1, len(groups)):
            changes.append(("group", groups[k - 1], groups[k]))
        for k in range(1, len(agents)):
            changes.append(("owner", agents[k - 1], agents[k]))
        if closed is not None:
            changes.append(("status", "Open", "Solved"))
        for j, (field, old, new) in enumerate(changes):
            when = t + step * ((j + 1) / (len(changes) + 1))
            if when >= HISTORY_START:
                history.append(dict(case_id=row["case_id"], changed_at=iso(when), field=field, old_value=old, new_value=new))

# planted date errors: about 1% closed before created
closed_rows = [r for r in cases if r["closed_at"]]
for r in rng.choice(len(closed_rows), size=int(len(closed_rows) * 0.011), replace=False):
    row = closed_rows[r]
    c = datetime.strptime(row["created_at"], "%Y-%m-%d %H:%M")
    row["closed_at"] = iso(c - timedelta(hours=int(rng.integers(2, 200))))

# planted duplicates: about 0.5% of rows repeated
dups = [dict(cases[i]) for i in rng.choice(len(cases), size=int(len(cases) * 0.005), replace=False)]
cases.extend(dups)
order = rng.permutation(len(cases))
cases = [cases[i] for i in order]

SNAPSHOT_COLS = ["case_id", "created_at", "closed_at", "status", "owner", "group", "reason", "subject", "description",
                 "account_id", "account_size", "product", "channel", "priority", "escalated", "resolution_note",
                 "linked_article", "last_update_at", "csat_score", "churned", "exit_event"]
HISTORY_COLS = SNAPSHOT_COLS + ["reopens", "assignee_stations", "group_stations", "requester_wait_minutes"]


def write(path, cols, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


write(OUT / "larkspur_snapshot.csv", SNAPSHOT_COLS, cases)
write(OUT / "larkspur_with_history.csv", HISTORY_COLS, cases)
write(OUT / "larkspur_history_log.csv", ["case_id", "changed_at", "field", "old_value", "new_value"],
      sorted(history, key=lambda h: h["changed_at"]))

stats = dict(seed=SEED, accounts=N_ACCOUNTS, accounts_with_cases=sum(1 for a in accounts if a["cases"]),
             cases=len(cases), history_rows=len(history),
             churned_accounts=sum(1 for a in accounts if a["churned"]))
(OUT / "generation_stats.json").write_text(json.dumps(stats, indent=2))
print(json.dumps(stats, indent=2))
