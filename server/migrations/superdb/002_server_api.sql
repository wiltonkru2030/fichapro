-- Execute no SQL Editor do projeto FichaPro. O SuperDB abre a transação.
-- O servidor atual opera um salão por instalação.
ALTER TABLE fichapro_forms ADD COLUMN invited_phone text;
ALTER TABLE fichapro_forms ADD COLUMN procedure text NOT NULL DEFAULT '';
ALTER TABLE fichapro_documents ADD COLUMN server_code text UNIQUE;
CREATE UNIQUE INDEX fichapro_google_per_salon ON fichapro_drive_connections(salon_id, google_account_id);

CREATE TABLE fichapro_clients (
  salon_id uuid NOT NULL REFERENCES fichapro_salons(id),
  phone text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (salon_id, phone)
);
CREATE TABLE fichapro_sessions (
  id text PRIMARY KEY,
  expires bigint NOT NULL
);
CREATE TABLE fichapro_oauth_states (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES fichapro_sessions(id) ON DELETE CASCADE,
  verifier text NOT NULL,
  expires bigint NOT NULL
);
ALTER TABLE fichapro_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichapro_oauth_states ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION fichapro_server(operation text, args jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = proj_p_be928f3912, pg_catalog, pg_temp
AS $fn$
DECLARE
  studio CONSTANT uuid := '99cb9876-d214-438a-8b07-20329dbf5b32';
  now_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  form_number bigint := CASE WHEN operation IN ('submit','notify','form','active_document','assessment','issue') THEN (args->>'id')::bigint END;
  previous_code text;
  doc_id uuid;
  drive_id uuid;
  replaced_time timestamptz;
  result jsonb;
BEGIN
  CASE operation
    WHEN 'health' THEN RETURN 'true';
    WHEN 'session_create' THEN
      DELETE FROM fichapro_sessions WHERE expires < now_ms;
      INSERT INTO fichapro_sessions VALUES (args->>'id', (args->>'expires')::bigint);
    WHEN 'session_active' THEN
      RETURN to_jsonb(EXISTS (SELECT 1 FROM fichapro_sessions WHERE id=args->>'id' AND expires>now_ms));
    WHEN 'session_delete' THEN
      DELETE FROM fichapro_sessions WHERE id=args->>'id';
    WHEN 'state_create' THEN
      DELETE FROM fichapro_oauth_states WHERE expires<now_ms OR session_id=args->>'session';
      INSERT INTO fichapro_oauth_states VALUES (args->>'state', args->>'session', args->>'verifier', (args->>'expires')::bigint);
    WHEN 'state_take' THEN
      DELETE FROM fichapro_oauth_states WHERE id=args->>'state' AND session_id=args->>'session' AND expires>now_ms
        RETURNING jsonb_build_object('verifier', verifier) INTO result;
      RETURN result;
    WHEN 'drive_active', 'drive_account' THEN
      SELECT jsonb_build_object('id', id, 'root', root_folder_id, 'refresh', encode(encrypted_refresh_token,'hex'))
        INTO result FROM fichapro_drive_connections WHERE salon_id=studio AND
        ((operation='drive_active' AND disconnected_at IS NULL) OR (operation='drive_account' AND google_account_id=args->>'account'));
      RETURN result;
    WHEN 'drive_connect' THEN
      INSERT INTO fichapro_salons(id,name) VALUES (studio,args->>'salon') ON CONFLICT (id) DO NOTHING;
      PERFORM 1 FROM fichapro_salons WHERE id=studio FOR UPDATE;
      UPDATE fichapro_drive_connections SET disconnected_at=now() WHERE salon_id=studio AND disconnected_at IS NULL;
      INSERT INTO fichapro_drive_connections(salon_id,google_account_id,root_folder_id,encrypted_refresh_token)
        VALUES (studio,args->>'account',args->>'root',decode(args->>'refresh','hex'))
        ON CONFLICT (salon_id,google_account_id) DO UPDATE SET
        root_folder_id=excluded.root_folder_id, encrypted_refresh_token=excluded.encrypted_refresh_token, disconnected_at=NULL;
    WHEN 'client_create' THEN
      INSERT INTO fichapro_salons(id,name) VALUES (studio,args->>'salon') ON CONFLICT (id) DO NOTHING;
      INSERT INTO fichapro_clients VALUES (studio,args->>'phone',args->>'name') ON CONFLICT DO NOTHING;
      RETURN to_jsonb(FOUND);
    WHEN 'invite_create' THEN
      INSERT INTO fichapro_salons(id,name) VALUES (studio,args->>'salon') ON CONFLICT (id) DO NOTHING;
      IF nullif(args->>'phone','') IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM fichapro_clients WHERE salon_id=studio AND phone=args->>'phone') THEN
        RAISE EXCEPTION 'Cliente não encontrada' USING ERRCODE='FP404';
      END IF;
      INSERT INTO fichapro_forms(salon_id,link_digest,expires_at,invited_phone,procedure)
        VALUES (studio,args->>'digest',to_timestamp((args->>'expires')::bigint / 1000.0),nullif(args->>'phone',''),args->>'procedure')
        RETURNING id INTO form_number;
      RETURN to_jsonb(form_number);
    WHEN 'prefill' THEN
      SELECT jsonb_build_object('id',id,'expires',floor(extract(epoch FROM expires_at)*1000),
        'submitted',submitted_at,'notification',notification_status,'procedure',procedure)
        INTO result FROM fichapro_forms WHERE salon_id=studio AND link_digest=args->>'link';
      RETURN result;
    WHEN 'submit' THEN
      UPDATE fichapro_forms SET customer=args->'customer',submitted_at=to_timestamp((args->>'submitted')::bigint/1000.0),
        notification_status='em_envio' WHERE salon_id=studio AND id=form_number AND submitted_at IS NULL AND expires_at>now();
      RETURN to_jsonb(FOUND);
    WHEN 'notify' THEN
      UPDATE fichapro_forms SET notification_status=args->>'status' WHERE salon_id=studio AND id=form_number;
    WHEN 'verification' THEN
      SELECT jsonb_build_object('form_id',form_id,'issued',floor(extract(epoch FROM issued_at)*1000),
        'digest',pdf_digest,'replaced',replaced_at IS NOT NULL)
        INTO result FROM fichapro_documents WHERE salon_id=studio AND verification_digest=args->>'digest';
      RETURN result;
    WHEN 'dashboard' THEN
      RETURN jsonb_build_object(
        'clients',coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'phone',phone) ORDER BY name)
          FROM fichapro_clients WHERE salon_id=studio),'[]'),
        'pending',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',c.name,'procedure',f.procedure,
          'expires',floor(extract(epoch FROM f.expires_at)*1000)) ORDER BY f.id DESC)
          FROM fichapro_forms f LEFT JOIN fichapro_clients c ON c.salon_id=f.salon_id AND c.phone=f.invited_phone
          WHERE f.salon_id=studio AND f.submitted_at IS NULL AND f.expires_at>now()),'[]'),
        'forms',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',customer->>'name',
          'phone',customer->>'phone','procedure',customer->>'procedure','submitted',floor(extract(epoch FROM submitted_at)*1000),
          'notification',notification_status) ORDER BY id DESC)
          FROM fichapro_forms WHERE salon_id=studio AND submitted_at IS NOT NULL),'[]'),
        'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('code',d.server_code,'id',d.form_id,
          'issued',floor(extract(epoch FROM d.issued_at)*1000),'replaced',d.replaced_at IS NOT NULL,'name',f.customer->>'name')
          ORDER BY d.issued_at DESC) FROM fichapro_documents d JOIN fichapro_forms f ON f.id=d.form_id
          WHERE d.salon_id=studio AND d.server_code IS NOT NULL),'[]'));
    WHEN 'form' THEN
      SELECT jsonb_build_object('customer',customer,'assessment',assessment) INTO result
        FROM fichapro_forms WHERE salon_id=studio AND id=form_number AND submitted_at IS NOT NULL;
      RETURN result;
    WHEN 'document', 'active_document' THEN
      SELECT jsonb_build_object('code',d.server_code,'form_id',d.form_id,'pdf_id',d.drive_file_id,'digest',d.pdf_digest,
        'account',c.google_account_id) INTO result FROM fichapro_documents d
        JOIN fichapro_drive_connections c ON c.salon_id=d.salon_id AND c.id=d.drive_connection_id
        WHERE d.salon_id=studio AND ((operation='document' AND d.server_code=args->>'code') OR
          (operation='active_document' AND d.form_id=form_number AND d.replaced_at IS NULL));
      RETURN result;
    WHEN 'assessment' THEN
      UPDATE fichapro_forms SET assessment=args->'assessment'
        WHERE salon_id=studio AND id=form_number AND submitted_at IS NOT NULL;
    WHEN 'issue' THEN
      PERFORM 1 FROM fichapro_forms WHERE salon_id=studio AND id=form_number AND submitted_at IS NOT NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Ficha inexistente' USING ERRCODE='FP409'; END IF;
      SELECT server_code INTO previous_code FROM fichapro_documents
        WHERE salon_id=studio AND form_id=form_number AND replaced_at IS NULL;
      IF previous_code IS DISTINCT FROM args->>'version' THEN
        RAISE EXCEPTION 'Versão desatualizada' USING ERRCODE='FP409';
      END IF;
      drive_id := (args->>'connection')::uuid;
      replaced_time := greatest(now(), to_timestamp((args->>'issued')::bigint/1000.0));
      UPDATE fichapro_documents SET replaced_at=greatest(issued_at,replaced_time)
        WHERE salon_id=studio AND form_id=form_number AND replaced_at IS NULL;
      INSERT INTO fichapro_documents(salon_id,form_id,drive_connection_id,drive_file_id,verification_digest,pdf_digest,issued_at,server_code)
        VALUES (studio,form_number,drive_id,args->>'pdf',args->>'verification',args->>'digest',replaced_time,args->>'code')
        RETURNING id INTO doc_id;
      INSERT INTO fichapro_document_photos(salon_id,document_id,drive_connection_id,kind,drive_file_id)
        SELECT studio,doc_id,drive_id,lower(key),value FROM jsonb_each_text(args->'photos');
      UPDATE fichapro_forms SET assessment=args->'assessment' WHERE salon_id=studio AND id=form_number;
    ELSE RAISE EXCEPTION 'Operação inválida' USING ERRCODE='22023';
  END CASE;
  RETURN 'true';
END
$fn$;

REVOKE ALL ON FUNCTION fichapro_server(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fichapro_server(text,jsonb) TO service_role;
