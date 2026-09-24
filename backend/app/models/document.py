"""
Database models — trimmed to what today's XR demo needs:
Document, ExtractedEntity, EmergencyProfile.
Multi-user auth/households from the original spec are Phase 2 work,
deliberately deferred past the hackathon (see chat notes).
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship
from app.core.db import Base


def _uuid():
    return str(uuid.uuid4())


class Document(Base):
    __tablename__ = "documents"

    id = Column(String, primary_key=True, default=_uuid)
    file_hash = Column(String, index=True, nullable=True)
    document_type = Column(String, default="unclassified")
    extracted_text = Column(Text, nullable=True)
    status = Column(String, default="uploaded")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    entities = relationship("ExtractedEntity", back_populates="document", cascade="all, delete-orphan")


class ExtractedEntity(Base):
    __tablename__ = "extracted_entities"

    id = Column(String, primary_key=True, default=_uuid)
    document_id = Column(String, ForeignKey("documents.id"))
    field_name = Column(String)
    field_value = Column(String, nullable=True)
    confidence_score = Column(Float, default=0.0)
    verified = Column(Boolean, default=False)

    document = relationship("Document", back_populates="entities")


class EmergencyProfile(Base):
    __tablename__ = "emergency_profiles"

    id = Column(String, primary_key=True, default=_uuid)
    blood_group = Column(String, nullable=True)
    allergies = Column(String, nullable=True)
    conditions = Column(String, nullable=True)
    emergency_contact = Column(String, nullable=True)
    preferred_hospital = Column(String, nullable=True)
    pin_hash = Column(String, nullable=True)
    public_token = Column(String, unique=True, default=lambda: uuid.uuid4().hex)