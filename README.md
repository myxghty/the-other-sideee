# MedBridge

**Medication continuity and safe handover between hospitals, clinics and pharmacies.**

Built for hackathon problem statement **PS4 – The Forgotten Prescription**.

> ⚠️ MedBridge runs on **synthetic data only**. It is a prototype, not a medical device. It shows what prescribers wrote; it never changes doses or tells anyone to stop a medicine.

---

## The problem

When a patient moves between a hospital, a clinic and a pharmacy, their medicine list is spread across prescriptions, discharge summaries and dispense records. Medicines get dropped, duplicated or changed without anyone noticing. MedBridge pulls these documents together, compares them, and puts every disagreement in front of a human before the patient moves on.

## What it does

| Page | Who | What it's for |
|---|---|---|
| **Compare lists** | Staff | Side-by-side view of a patient's medicine lists from different visits, with differences highlighted |
| **Review queue** | Staff | Open discrepancies waiting for a pharmacist or doctor to resolve; the sidebar shows the live count |
| **Upload document** | Everyone | Upload a prescription, discharge summary or pharmacy dispense record (JPG, PNG, PDF or TXT, up to 10 MB). Medicines are extracted in the background with a confidence score per line |
| **Audit history** | Staff | Every upload, review decision and handover-code use, in order |
| **Patient view** | Everyone | The patient's reconciled medicines, written as the doctor wrote them plus a plain-language version, with the source document and line for each |
| **Test lab** | Staff | Exercise load and concurrency scenarios against the running system |

### Handover codes

A patient can create a **handover code** from the Patient view. Authorised staff at the next hospital or pharmacy use it to see the reconciled list and any open questions. The code expires after **15 minutes** and every use is logged.

### Demo users

Use the **Signed in as** switcher in the top bar to move between staff and patient roles. Staff land on *Compare lists*; patients land on *Patient view*.

## Built for real-world constraints

MedBridge is designed around the organisers' two operating constraints:

1. **3× the patients with ½ the resources.** Pages poll only while work is in progress and slow down when the server reports high load. Document extraction runs in a background queue that shows the patient's position. When live data can't be fetched, the last good data is shown with a clear "stale" notice instead of a blank screen.
2. **Simultaneous edits, retries and duplicate submissions.** Every write carries an idempotency key, so double taps and network retries return the same result instead of creating a second record. Uploads are fingerprinted with SHA-256, so the same document uploaded twice is recognised and not stored again.

See [`docs/Constraint-and-Adaptation-Report.pdf`](docs/Constraint-and-Adaptation-Report.pdf) for the full write-up.

## Tech stack

- **Frontend:** React + Vite (`medtrail-frontend/`)
- **Backend:** Python (`medtrail-backend/`)
- **Fonts:** IBM Plex Sans and IBM Plex Mono

## Project structure

```
the-other-sideee/
├── medtrail-backend/          # Python API, extraction queue, audit log
└── medtrail-frontend/
    ├── public/
    │   └── logo.svg           # favicon
    ├── src/
    │   ├── api/               # endpoint wrappers
    │   ├── components/        # Layout, SourceDoc, shared UI
    │   ├── lib/               # store, router, query + idempotency hooks
    │   ├── pages/             # Compare, Review, Upload, Audit, PatientView, Lab
    │   ├── App.jsx
    │   ├── config.js          # patient ID, polling intervals per load level
    │   ├── main.jsx
    │   └── styles.css
    ├── .env.example
    ├── index.html
    └── package.json
```

## Getting started

### Prerequisites

- Node.js 18+
- Python 3.10+

### Backend

```bash
cd medtrail-backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# start the API (replace with your entry point)
python main.py
```

### Frontend

```bash
cd medtrail-frontend
cp .env.example .env             # point it at your backend URL
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Safety principles

- **Show, don't decide.** MedBridge displays what prescribers wrote, with the source document and line number. It never edits a dose.
- **Humans resolve disagreements.** Low-confidence extractions are flagged *Needs human check*. Disputed medicines stay *Being reviewed* until a pharmacist confirms them.
- **Everything is traceable.** Uploads, review decisions and handover-code uses all go to the audit log.
- **Synthetic data only.** Do not upload real patient documents.

## Team

Built for the PS4 hackathon track. Add team members here.

# MedBridge

**Medication continuity and safe handover between hospitals, clinics and pharmacies.**

Built for hackathon problem statement **PS4 – The Forgotten Prescription**.

> ⚠️ MedBridge runs on **synthetic data only**. It is a prototype, not a medical device. It shows what prescribers wrote; it never changes doses or tells anyone to stop a medicine.

---

## The problem

When a patient moves between a hospital, a clinic and a pharmacy, their medicine list is spread across prescriptions, discharge summaries and dispense records. Medicines get dropped, duplicated or changed without anyone noticing. MedBridge pulls these documents together, compares them, and puts every disagreement in front of a human before the patient moves on.

## What it does

| Page | Who | What it's for |
|---|---|---|
| **Compare lists** | Staff | Side-by-side view of a patient's medicine lists from different visits, with differences highlighted |
| **Review queue** | Staff | Open discrepancies waiting for a pharmacist or doctor to resolve; the sidebar shows the live count |
| **Upload document** | Everyone | Upload a prescription, discharge summary or pharmacy dispense record (JPG, PNG, PDF or TXT, up to 10 MB). Medicines are extracted in the background with a confidence score per line |
| **Audit history** | Staff | Every upload, review decision and handover-code use, in order |
| **Patient view** | Everyone | The patient's reconciled medicines, written as the doctor wrote them plus a plain-language version, with the source document and line for each |
| **Test lab** | Staff | Exercise load and concurrency scenarios against the running system |

### Handover codes

A patient can create a **handover code** from the Patient view. Authorised staff at the next hospital or pharmacy use it to see the reconciled list and any open questions. The code expires after **15 minutes** and every use is logged.

### Demo users

Use the **Signed in as** switcher in the top bar to move between staff and patient roles. Staff land on *Compare lists*; patients land on *Patient view*.

## Built for real-world constraints

MedBridge is designed around the organisers' two operating constraints:

1. **3× the patients with ½ the resources.** Pages poll only while work is in progress and slow down when the server reports high load. Document extraction runs in a background queue that shows the patient's position. When live data can't be fetched, the last good data is shown with a clear "stale" notice instead of a blank screen.
2. **Simultaneous edits, retries and duplicate submissions.** Every write carries an idempotency key, so double taps and network retries return the same result instead of creating a second record. Uploads are fingerprinted with SHA-256, so the same document uploaded twice is recognised and not stored again.

See [`docs/Constraint-and-Adaptation-Report.pdf`](docs/Constraint-and-Adaptation-Report.pdf) for the full write-up.

## Tech stack

- **Frontend:** React + Vite (`medtrail-frontend/`)
- **Backend:** Python (`medtrail-backend/`)
- **Hosting** FastAPI

## Project structure

```
the-other-sideee/
├── medtrail-backend/          # Python API, extraction queue, audit log
└── medtrail-frontend/
    ├── public/
    │   └── logo.svg           # favicon
    ├── src/
    │   ├── api/               # endpoint wrappers
    │   ├── components/        # Layout, SourceDoc, shared UI
    │   ├── lib/               # store, router, query + idempotency hooks
    │   ├── pages/             # Compare, Review, Upload, Audit, PatientView, Lab
    │   ├── App.jsx
    │   ├── config.js          # patient ID, polling intervals per load level
    │   ├── main.jsx
    │   └── styles.css
    ├── .env.example
    ├── index.html
    └── package.json
```

## Getting started

### Prerequisites

- Node.js 18+
- Python 3.10+

### Backend

```bash
cd medtrail-backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# start the API (replace with your entry point)
python main.py
```

### Frontend

```bash
cd medtrail-frontend
cp .env.example .env             # point it at your backend URL
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Safety principles

- **Show, don't decide.** MedBridge displays what prescribers wrote, with the source document and line number. It never edits a dose.
- **Humans resolve disagreements.** Low-confidence extractions are flagged *Needs human check*. Disputed medicines stay *Being reviewed* until a pharmacist confirms them.
- **Everything is traceable.** Uploads, review decisions and handover-code uses all go to the audit log.
- **Synthetic data only.** Do not upload real patient documents.

## Team

CherryMx

## License

MIT.