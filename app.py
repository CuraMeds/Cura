from fastapi import FastAPI, Depends, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uuid, os

from src.icd_loader import ICD_KEYWORDS, NHIA_RULES, FORMULARY, HOSPITAL_NAME
from src.nhia_audit import run_nhia_audit
from src.discharge_templates import generate_discharge
from src.keyword_mapper import keyword_search_icd10
from src.drug_checker import check_interactions
from src.audit import log_action
from src.auth import fake_login
from src.nhia_export import generate_nhia_excel
from src.gdrg_tariff import calculate_nhia_amount

# DB-backed repositories
from database.db import init_pool
from repositories.hospital_repository import HospitalRepository
from repositories.claim_repository import ClaimRepository

# initialize DB pool on startup if env provided
try:
    init_pool()
except Exception:
    # allow local dev without DB configured; operations will raise meaningful errors later
    pass

app = FastAPI(title=f"CuraMeds - {HOSPITAL_NAME}")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
"""
Replaces in-memory CLAIMS_BATCH with persistent storage via PostgreSQL.
Processing will persist claims and related data using repositories.
"""

class NoteIn(BaseModel):
    note: str
    days: int = 1
    addons: list = []
    user_id: str = "dr_ade"

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "hospital_name": HOSPITAL_NAME,
        "total_codes": len(ICD_KEYWORDS)
    })

@app.post("/process")
def process_note(data: NoteIn, user = Depends(fake_login)):
    note = data.note
    diagnosis = extract_diagnosis(note)
    meds = extract_meds(note)
    icd_codes = keyword_search_icd10(note, ICD_KEYWORDS)
    audit_flags = run_nhia_audit(note, diagnosis, meds, NHIA_RULES)
    safety = check_interactions(meds, FORMULARY)
    discharge = generate_discharge({"diagnosis": diagnosis, "meds": meds, "note": note})
    main_icd = icd_codes[0]['code']
    gdrg_calc = calculate_nhia_amount(main_icd, days=data.days, addons=data.addons, flags=audit_flags['flags'])

    # persist to DB using repositories
    hospital_id = HospitalRepository.ensure_default_hospital()

    claim_payload = {
        'hospital_id': hospital_id,
        'patient_id': None,
        'claim_reference': None,
        'current_status_id': None,
        'admission_date': None,
        'discharge_date': None,
        'days_on_admission': data.days,
        'primary_icd_code_id': None,
        'raw_note': note,
        'note_hash': str(hash(note)),
        'extracted_diagnosis': diagnosis,
        'discharge_summary': discharge,
        'total_amount': gdrg_calc.get('calculated_amount'),
        'estimated_payout': None,
        'nhia_flags_count': len(audit_flags.get('flags', [])),
        'tariff_breakdown': gdrg_calc.get('breakdown'),
        'currency_code': 'NGN',
        'source_system': 'curameds',
        'source_reference': None
    }
    created_by = None
    claim_id = ClaimRepository.create_claim(claim_payload, created_by=created_by)

    # persist diagnoses, medications, icd mappings and audit flags as available
    # adapt existing outputs into DB-friendly shapes
    diag_rows = []
    for idx, icd in enumerate(icd_codes):
        diag_rows.append({
            'diagnosis_role_id': None,
            'icd_code_id': None,
            'diagnosis_text': icd.get('keyword',''),
            'rank': idx+1,
            'confidence_score': None,
            'source': 'nlp',
            'normalized': True
        })
    ClaimRepository.insert_diagnoses(claim_id, diag_rows)

    meds_rows = []
    for m in meds:
        meds_rows.append({
            'drug_id': None,
            'formulary_entry_id': None,
            'raw_name': m,
            'normalized_name': m,
            'generic_name': None,
            'brand_name': None,
            'strength': None,
            'dosage': None,
            'frequency': None,
            'route': None,
            'normalized': False,
            'confidence_score': None,
            'source': 'nlp',
            'is_on_formulary': m in FORMULARY
        })
    ClaimRepository.insert_medications(claim_id, meds_rows)

    icd_mappings = []
    for idx, icd in enumerate(icd_codes):
        icd_mappings.append({
            'icd_code_id': None,
            'icd_code_keyword_id': None,
            'keyword_text': icd.get('keyword'),
            'is_primary': idx == 0,
            'source': 'nlp',
            'confidence_score': None
        })
    ClaimRepository.insert_icd_mappings(claim_id, icd_mappings)

    ClaimRepository.insert_audit_flags(claim_id, audit_flags.get('flags', []))

    # simple report entry
    ClaimRepository.insert_report(claim_id, {
        'claim_report_type_id': None,
        'generated_by': created_by,
        'title': f'Processed claim {claim_id}',
        'summary': 'Auto-generated report',
        'report_data': {},
        'file_name': None,
        'file_path': None
    })

    log_action(user["id"], action="processed_note", note_hash=hash(note))

    return {
        "claim_id": claim_id,
        "diagnosis": diagnosis,
        "meds": meds,
        "discharge": discharge,
        "icd_codes": icd_codes,
        "gdrg": gdrg_calc,
        "nhia_audit": audit_flags,
        "safety": safety,
    }

@app.get("/export")
def export_claims():
    # Create an export batch and include recent claims (simple heuristic: last 20 claims)
    # For now we will fetch recent claims and export them
    from database.db import get_conn
    import os
    with get_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT claim_id, raw_note, updated_at FROM claims ORDER BY updated_at DESC LIMIT 100")
        rows = cur.fetchall()
        if not rows:
            return {"error": "No claims available for export"}
        # build processed_claims like legacy structure
        processed = []
        for r in rows:
            claim_id, raw_note, updated_at = r
            # minimal processed claim from DB
            processed.append({
                'note': raw_note,
                'icd_codes': [{'code': 'R69', 'description': 'Unknown'}],
                'nhia_audit': {'flags': []},
                'meds': []
            })
        filepath, count = generate_nhia_excel(processed, HOSPITAL_NAME)
        return FileResponse(filepath, filename=os.path.basename(filepath))

def extract_diagnosis(note):
    note_lower = note.lower()
    for keyword in ICD_KEYWORDS.keys():
        if keyword in note_lower:
            return keyword.title()
    return "Unspecified"

def extract_meds(note):
    note_lower = note.lower()
    return [m for m in FORMULARY if m.lower() in note_lower]

if __name__ == "__main__":
    import uvicorn
    print(f"Running CuraMeds with {len(ICD_KEYWORDS)} ICD-10 codes")
    uvicorn.run(app, host="0.0.0.0", port=8000)
