from app.core.db import engine
from sqlalchemy import text

with engine.connect() as conn:
    conn.execute(text('ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_hash VARCHAR;'))
    conn.execute(text('CREATE INDEX IF NOT EXISTS ix_documents_file_hash ON documents (file_hash);'))
    conn.commit()
    print("Added file_hash")
