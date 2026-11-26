-- Projeto SuperDB FichaPro. As chamadas passam pelo servidor do aplicativo.
-- RLS começa fechada aos papéis da API pública.
BEGIN;

CREATE TABLE fichapro_salons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fichapro_drive_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    salon_id uuid NOT NULL REFERENCES fichapro_salons(id),
    google_account_id text NOT NULL,
    root_folder_id text NOT NULL,
    encrypted_refresh_token bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    disconnected_at timestamptz,
    UNIQUE (salon_id, id)
);

CREATE UNIQUE INDEX fichapro_one_active_drive
    ON fichapro_drive_connections (salon_id) WHERE disconnected_at IS NULL;

CREATE TABLE fichapro_forms (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    salon_id uuid NOT NULL REFERENCES fichapro_salons(id),
    link_digest text NOT NULL UNIQUE CHECK (link_digest ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    customer jsonb CHECK (jsonb_typeof(customer) = 'object'),
    assessment jsonb CHECK (jsonb_typeof(assessment) = 'object'),
    submitted_at timestamptz,
    notification_status text CHECK (notification_status IN
        ('em_envio', 'aceito', 'incerto', 'rejeitado', 'sem_integracao')),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((submitted_at IS NULL) = (customer IS NULL)),
    UNIQUE (salon_id, id)
);

CREATE INDEX fichapro_submitted_forms
    ON fichapro_forms (salon_id, id DESC) WHERE submitted_at IS NOT NULL;

CREATE TABLE fichapro_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    salon_id uuid NOT NULL,
    form_id bigint NOT NULL,
    drive_connection_id uuid NOT NULL,
    drive_file_id text NOT NULL,
    verification_digest text NOT NULL UNIQUE CHECK (verification_digest ~ '^[0-9a-f]{64}$'),
    pdf_digest text NOT NULL CHECK (pdf_digest ~ '^[0-9a-f]{64}$'),
    issued_at timestamptz NOT NULL DEFAULT now(),
    replaced_at timestamptz CHECK (replaced_at >= issued_at),
    FOREIGN KEY (salon_id, form_id) REFERENCES fichapro_forms (salon_id, id),
    FOREIGN KEY (salon_id, drive_connection_id) REFERENCES fichapro_drive_connections (salon_id, id),
    UNIQUE (salon_id, id),
    UNIQUE (drive_connection_id, drive_file_id)
);

CREATE UNIQUE INDEX fichapro_one_current_document
    ON fichapro_documents (salon_id, form_id) WHERE replaced_at IS NULL;

CREATE TABLE fichapro_document_photos (
    salon_id uuid NOT NULL,
    document_id uuid NOT NULL,
    drive_connection_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('antes', 'depois')),
    drive_file_id text NOT NULL,
    PRIMARY KEY (document_id, kind),
    FOREIGN KEY (salon_id, document_id) REFERENCES fichapro_documents (salon_id, id),
    FOREIGN KEY (salon_id, drive_connection_id) REFERENCES fichapro_drive_connections (salon_id, id),
    UNIQUE (drive_connection_id, drive_file_id)
);

ALTER TABLE fichapro_salons ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_drive_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_document_photos ENABLE ROW LEVEL SECURITY;

COMMIT;
