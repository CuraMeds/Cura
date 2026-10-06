from database.db import transaction, gen_uuid
import hashlib
import json
import uuid


class ClaimRepository:
    """Repository aligned with the normalized CuraMeds claims database schema."""

    @staticmethod
    def _is_uuid(value):
        if value is None:
            return False
        try:
            uuid.UUID(str(value).strip())
            return True
        except (ValueError, TypeError, AttributeError):
            return False

    @staticmethod
    def _resolve_user_id(cur, value, required=True):
        """Resolve either users.user_id or users.username to users.user_id."""
        if not value:
            if required:
                raise ValueError(
                    "created_by is required. Supply an active username or users.user_id."
                )
            return None

        value = str(value).strip()

        if ClaimRepository._is_uuid(value):
            cur.execute(
                """
                SELECT user_id
                FROM users
                WHERE user_id = %s
                  AND is_active = TRUE
                  AND deleted_at IS NULL
                LIMIT 1
                """,
                (value,),
            )
        else:
            cur.execute(
                """
                SELECT user_id
                FROM users
                WHERE username = %s
                  AND is_active = TRUE
                  AND deleted_at IS NULL
                LIMIT 1
                """,
                (value,),
            )

        row = cur.fetchone()
        if row:
            return row[0]

        if required:
            raise ValueError(
                f"Could not resolve user {value!r}. "
                "Make sure the username exists and is active."
            )
        return None

    @staticmethod
    def _resolve_status_id(cur, value="processed"):
        """Resolve a status code such as 'processed' to its UUID FK."""
        value = str(value or "processed").strip()

        if ClaimRepository._is_uuid(value):
            cur.execute(
                """
                SELECT claim_status_id
                FROM claim_statuses
                WHERE claim_status_id = %s
                  AND is_active = TRUE
                LIMIT 1
                """,
                (value,),
            )
        else:
            cur.execute(
                """
                SELECT claim_status_id
                FROM claim_statuses
                WHERE code = %s
                  AND is_active = TRUE
                ORDER BY version DESC
                LIMIT 1
                """,
                (value,),
            )

        row = cur.fetchone()
        if not row:
            raise ValueError(
                f"Could not resolve claim status {value!r}. "
                "current_status_id is a UUID FK, so the status code must "
                "exist in claim_statuses."
            )
        return row[0]

    @staticmethod
    def _resolve_diagnosis_role_id(cur, value=None, primary=False):
        """Resolve required diagnosis_roles FK."""
        if value:
            value = str(value).strip()
            if ClaimRepository._is_uuid(value):
                cur.execute(
                    """
                    SELECT diagnosis_role_id
                    FROM diagnosis_roles
                    WHERE diagnosis_role_id = %s
                      AND is_active = TRUE
                    LIMIT 1
                    """,
                    (value,),
                )
            else:
                cur.execute(
                    """
                    SELECT diagnosis_role_id
                    FROM diagnosis_roles
                    WHERE code = %s
                      AND is_active = TRUE
                    LIMIT 1
                    """,
                    (value,),
                )
            row = cur.fetchone()
            if row:
                return row[0]
            raise ValueError(f"Could not resolve diagnosis role {value!r}.")

        candidates = (
            ("primary", "principal", "main")
            if primary
            else ("secondary", "other")
        )
        for code in candidates:
            cur.execute(
                """
                SELECT diagnosis_role_id
                FROM diagnosis_roles
                WHERE code = %s
                  AND is_active = TRUE
                LIMIT 1
                """,
                (code,),
            )
            row = cur.fetchone()
            if row:
                return row[0]

        raise ValueError(
            "claim_diagnoses requires diagnosis_role_id. "
            "Pass it explicitly or seed diagnosis_roles with primary/secondary."
        )

    @staticmethod
    def _resolve_audit_level_id(cur, value):
        if not value:
            value = "INFO"

        level_map = {
            "GREEN": "info",
            "YELLOW": "warning",
            "RED": "critical",
            "INFO": "info",
            "WARNING": "warning",
            "CRITICAL": "critical",
        }

        code = level_map.get(str(value).strip().upper())

        if not code:
            raise ValueError(
                f"Could not resolve audit level {value!r}."
            )

        cur.execute(
            """
            SELECT audit_level_id
            FROM audit_levels
            WHERE LOWER(code) = LOWER(%s)
            LIMIT 1
            """,
        (code,),
        )

        row = cur.fetchone()

        if not row:
            raise ValueError(
                f"Audit level code {code!r} does not exist in audit_levels."
            )

        return row[0]


    @staticmethod
    def _resolve_report_type_id(cur, value=None):
        """Resolve claim_report_types UUID from UUID or code."""
        value = str(value or "other").strip()

        if ClaimRepository._is_uuid(value):
            cur.execute(
                """
                SELECT claim_report_type_id
                FROM claim_report_types
                WHERE claim_report_type_id = %s
                  AND is_active = TRUE
                LIMIT 1
                """,
                (value,),
            )
        else:
            cur.execute(
                """
                SELECT claim_report_type_id
                FROM claim_report_types
                WHERE code = %s
                  AND is_active = TRUE
                LIMIT 1
                """,
                (value,),
            )

        row = cur.fetchone()
        if not row:
            raise ValueError(f"Could not resolve claim report type {value!r}.")
        return row[0]

    @staticmethod
    def create_claim(claim_data, created_by=None):
        """
        Create a claim using the ACTUAL normalized schema.

        Key schema rule:
            claims.current_status_id -> claim_statuses.claim_status_id (UUID)

        Therefore 'processed' must NEVER be inserted directly into
        current_status_id. It is first resolved to the UUID belonging to
        claim_statuses.code = 'processed'.

        created_by may be a username or UUID. For compatibility, user_id
        or created_by may also be supplied inside claim_data.
        """
        claim_data = claim_data or {}

        with transaction() as cur:
            claim_id = gen_uuid()

            effective_created_by = (
                created_by
                or claim_data.get("created_by")
                or claim_data.get("user_id")
            )
            created_by_id = ClaimRepository._resolve_user_id(
                cur, effective_created_by, required=True
            )

            hospital_id = claim_data.get("hospital_id")
            if not hospital_id:
                raise ValueError("hospital_id is required.")

            raw_note = (claim_data.get("raw_note") or "").strip()
            if not raw_note:
                raise ValueError("raw_note cannot be empty.")

            note_hash = hashlib.sha256(
                raw_note.encode("utf-8")
            ).hexdigest()

            current_status = (
                claim_data.get("current_status_id")
                or claim_data.get("status")
                or "processing"
            )
            current_status_id = ClaimRepository._resolve_status_id(
                cur, current_status
            )

            assigned_to = None
            if claim_data.get("assigned_to"):
                assigned_to = ClaimRepository._resolve_user_id(
                    cur, claim_data["assigned_to"], required=True
                )

            primary_icd_code_id = claim_data.get("primary_icd_code_id")
            if primary_icd_code_id:
                cur.execute(
                    """
                    SELECT icd_code_id
                    FROM icd_codes
                    WHERE icd_code_id = %s
                      AND deleted_at IS NULL
                    LIMIT 1
                    """,
                    (primary_icd_code_id,),
                )
                if not cur.fetchone():
                    raise ValueError(
                        f"primary_icd_code_id {primary_icd_code_id!r} "
                        "does not exist in icd_codes."
                    )

            days = max(int(claim_data.get("days_on_admission") or 1), 1)
            total_amount = (
                claim_data["total_amount"]
                if claim_data.get("total_amount") is not None
                else 0
            )
            estimated_payout = (
                claim_data["estimated_payout"]
                if claim_data.get("estimated_payout") is not None
                else total_amount
            )
            flags_count = max(
                int(claim_data.get("nhia_flags_count") or 0), 0
            )

            status_code = str(current_status).lower()
            processed_at = None
            if status_code == "processed":
                processed_at = None

            cur.execute(
                """
                INSERT INTO claims (
                    claim_id,
                    hospital_id,
                    patient_id,
                    claim_reference,
                    current_status_id,
                    created_by,
                    assigned_to,
                    assigned_at,
                    admission_date,
                    discharge_date,
                    days_on_admission,
                    primary_icd_code_id,
                    raw_note,
                    note_hash,
                    extracted_diagnosis,
                    discharge_summary,
                    total_amount,
                    estimated_payout,
                    nhia_flags_count,
                    tariff_breakdown,
                    currency_code,
                    source_system,
                    source_reference,
                    is_active,
                    created_at,
                    processed_at,
                    updated_at
                )
                VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, TRUE, now(), %s, now()
                )
                """,
                (
                    claim_id,
                    hospital_id,
                    claim_data.get("patient_id"),
                    claim_data.get("claim_reference"),
                    current_status_id,
                    created_by_id,
                    assigned_to,
                    claim_data.get("assigned_at"),
                    claim_data.get("admission_date"),
                    claim_data.get("discharge_date"),
                    days,
                    primary_icd_code_id,
                    raw_note,
                    note_hash,
                    claim_data.get("extracted_diagnosis") or "Unspecified",
                    claim_data.get("discharge_summary") or "",
                    total_amount,
                    estimated_payout,
                    flags_count,
                    claim_data.get("tariff_breakdown"),
                    claim_data.get("currency_code") or "NGN",
                    claim_data.get("source_system"),
                    claim_data.get("source_reference"),
                    processed_at,
                ),
            )
            return claim_id

    @staticmethod
    def insert_diagnoses(claim_id, diagnoses):
        if not diagnoses:
            return

        with transaction() as cur:
            for index, diagnosis in enumerate(diagnoses):
                diagnosis = diagnosis or {}
                text = (
                    diagnosis.get("diagnosis_text")
                    or diagnosis.get("keyword")
                    or diagnosis.get("description")
                    or ""
                ).strip()
                if not text:
                    continue

                role_id = ClaimRepository._resolve_diagnosis_role_id(
                    cur,
                    diagnosis.get("diagnosis_role_id")
                    or diagnosis.get("diagnosis_role"),
                    primary=bool(
                        diagnosis.get("is_primary") or index == 0
                    ),
                )

                rank = int(diagnosis.get("rank") or index + 1)

                cur.execute(
                    """
                    INSERT INTO claim_diagnoses (
                        claim_diagnosis_id,
                        claim_id,
                        diagnosis_role_id,
                        icd_code_id,
                        diagnosis_text,
                        rank,
                        confidence_score,
                        source,
                        normalized,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        now(), now()
                    )
                    ON CONFLICT (claim_id, diagnosis_role_id, rank)
                    DO UPDATE SET
                        icd_code_id = EXCLUDED.icd_code_id,
                        diagnosis_text = EXCLUDED.diagnosis_text,
                        confidence_score = EXCLUDED.confidence_score,
                        source = EXCLUDED.source,
                        normalized = EXCLUDED.normalized,
                        updated_at = now()
                    """,
                    (
                        gen_uuid(),
                        claim_id,
                        role_id,
                        diagnosis.get("icd_code_id"),
                        text,
                        rank,
                        diagnosis.get("confidence_score"),
                        diagnosis.get("source"),
                        bool(diagnosis.get("normalized", False)),
                    ),
                )

    @staticmethod
    def insert_medications(claim_id, meds):
        if not meds:
            return

        with transaction() as cur:
            for medication in meds:
                if isinstance(medication, str):
                    raw_name = medication.strip()
                    data = {}
                else:
                    data = medication or {}
                    raw_name = (
                        data.get("raw_name")
                        or data.get("medication_text")
                        or data.get("normalized_name")
                        or ""
                    ).strip()

                if not raw_name:
                    continue

                cur.execute(
                    """
                    INSERT INTO claim_medications (
                        claim_medication_id,
                        claim_id,
                        drug_id,
                        formulary_entry_id,
                        raw_name,
                        normalized_name,
                        generic_name,
                        brand_name,
                        strength,
                        dosage,
                        frequency,
                        route,
                        normalized,
                        confidence_score,
                        source,
                        is_on_formulary,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, now(), now()
                    )
                    ON CONFLICT (claim_id, raw_name)
                    DO UPDATE SET
                        drug_id = EXCLUDED.drug_id,
                        formulary_entry_id = EXCLUDED.formulary_entry_id,
                        normalized_name = EXCLUDED.normalized_name,
                        generic_name = EXCLUDED.generic_name,
                        brand_name = EXCLUDED.brand_name,
                        strength = EXCLUDED.strength,
                        dosage = EXCLUDED.dosage,
                        frequency = EXCLUDED.frequency,
                        route = EXCLUDED.route,
                        normalized = EXCLUDED.normalized,
                        confidence_score = EXCLUDED.confidence_score,
                        source = EXCLUDED.source,
                        is_on_formulary = EXCLUDED.is_on_formulary,
                        updated_at = now()
                    """,
                    (
                        gen_uuid(),
                        claim_id,
                        data.get("drug_id"),
                        data.get("formulary_entry_id"),
                        raw_name,
                        data.get("normalized_name"),
                        data.get("generic_name"),
                        data.get("brand_name"),
                        data.get("strength"),
                        data.get("dosage"),
                        data.get("frequency"),
                        data.get("route"),
                        bool(data.get("normalized", False)),
                        data.get("confidence_score"),
                        data.get("source"),
                        bool(data.get("is_on_formulary", False)),
                    ),
                )

    @staticmethod
    def insert_icd_mappings(claim_id, mappings):
        if not mappings:
            return

        with transaction() as cur:
            for mapping in mappings:
                mapping = mapping or {}
                icd_code_id = mapping.get("icd_code_id")

                # app.py currently sends None for this FK. Skipping the row
                # is safer than attempting to insert an invalid UUID.
                if not icd_code_id:
                    continue

                keyword = (
                    mapping.get("keyword_text")
                    or mapping.get("keyword")
                    or ""
                ).strip()
                if not keyword:
                    continue

                cur.execute(
                    """
                    INSERT INTO claim_icd_mappings (
                        claim_icd_mapping_id,
                        claim_id,
                        icd_code_id,
                        icd_code_keyword_id,
                        keyword_text,
                        is_primary,
                        source,
                        confidence_score,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        now(), now()
                    )
                    ON CONFLICT (claim_id, icd_code_id)
                    DO UPDATE SET
                        icd_code_keyword_id = EXCLUDED.icd_code_keyword_id,
                        keyword_text = EXCLUDED.keyword_text,
                        is_primary = EXCLUDED.is_primary,
                        source = EXCLUDED.source,
                        confidence_score = EXCLUDED.confidence_score,
                        updated_at = now()
                    """,
                    (
                        gen_uuid(),
                        claim_id,
                        icd_code_id,
                        mapping.get("icd_code_keyword_id"),
                        keyword,
                        bool(mapping.get("is_primary", False)),
                        mapping.get("source"),
                        mapping.get("confidence_score"),
                    ),
                )

    @staticmethod
    def insert_audit_flags(claim_id, flags):
        if not flags:
            return

        with transaction() as cur:
            for flag in flags:
                flag = flag or {}
                issue = (flag.get("issue") or "").strip()
                if not issue:
                    continue

                level_id = ClaimRepository._resolve_audit_level_id(
                    cur,
                    flag.get("audit_level_id")
                    or flag.get("level")
                    or flag.get("severity")
                    or "INFO",
                )

                cur.execute(
                    """
                    INSERT INTO claim_audit_flags (
                        claim_audit_flag_id,
                        claim_id,
                        audit_rule_id,
                        audit_level_id,
                        issue,
                        fix,
                        revenue_at_risk,
                        penalty_amount,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s,
                        now(), now()
                    )
                    """,
                    (
                        gen_uuid(),
                        claim_id,
                        flag.get("audit_rule_id"),
                        level_id,
                        issue,
                        (
                            flag.get("fix")
                            or "Review and correct the flagged issue."
                        ),
                        flag.get("revenue_at_risk") or 0,
                        flag.get("penalty_amount") or 0,
                    ),
                )

    @staticmethod
    def insert_report(claim_id, report):
        report = report or {}

        with transaction() as cur:
            report_type_id = ClaimRepository._resolve_report_type_id(
                cur,
                report.get("claim_report_type_id")
                or report.get("report_type")
                or report.get("type")
                or "audit_report",
            )

            generated_by = None
            if report.get("generated_by"):
                generated_by = ClaimRepository._resolve_user_id(
                    cur, report["generated_by"], required=True
                )

            cur.execute(
                """
                INSERT INTO claim_reports (
                    claim_report_id,
                    claim_id,
                    claim_report_type_id,
                    generated_by,
                    generated_at,
                    title,
                    summary,
                    report_data,
                    file_name,
                    file_path,
                    created_at,
                    updated_at
                )
                VALUES (
                    %s, %s, %s, %s, now(), %s, %s, %s::jsonb,
                    %s, %s, now(), now()
                )
                """,
                (
                    gen_uuid(),
                    claim_id,
                    report_type_id,
                    generated_by,
                    report.get("title") or "Claim Report",
                    report.get("summary") or "",
                    json.dumps(report.get("report_data") or {}),
                    report.get("file_name"),
                    report.get("file_path"),
                ),
            )

    @staticmethod
    def record_status_change(
        claim_id,
        new_status,
        changed_by,
        old_status_id=None,
        reason=None,
        metadata=None,
    ):
        """Write normalized status history and update claims.current_status_id."""
        with transaction() as cur:
            new_status_id = ClaimRepository._resolve_status_id(
                cur, new_status
            )
            changed_by_id = ClaimRepository._resolve_user_id(
                cur, changed_by, required=True
            )

            cur.execute(
                """
                INSERT INTO claim_status_history (
                    claim_status_history_id,
                    claim_id,
                    old_status_id,
                    new_status_id,
                    changed_by,
                    changed_at,
                    reason,
                    metadata
                )
                VALUES (
                    %s, %s, %s, %s, %s, now(), %s, %s::jsonb
                )
                """,
                (
                    gen_uuid(),
                    claim_id,
                    old_status_id,
                    new_status_id,
                    changed_by_id,
                    reason,
                    json.dumps(metadata or {}),
                ),
            )

            cur.execute(
                """
                UPDATE claims
                SET current_status_id = %s,
                    processed_at = CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM claim_statuses
                            WHERE claim_status_id = %s
                              AND code = 'processed'
                        )
                        THEN COALESCE(processed_at, now())
                        ELSE processed_at
                    END,
                    exported_at = CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM claim_statuses
                            WHERE claim_status_id = %s
                              AND code = 'exported'
                        )
                        THEN COALESCE(exported_at, now())
                        ELSE exported_at
                    END,
                    updated_at = now()
                WHERE claim_id = %s
                """,
                (
                    new_status_id,
                    new_status_id,
                    new_status_id,
                    claim_id,
                ),
            )

            return new_status_id