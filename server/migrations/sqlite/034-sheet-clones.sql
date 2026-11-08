ALTER TABLE reports RENAME TO sheet_clones;
ALTER TABLE report_documents RENAME TO sheet_clone_documents;
ALTER TABLE sheet_clone_documents RENAME COLUMN report_id TO sheet_clone_id;
ALTER TABLE report_memos RENAME TO sheet_clone_memos;
ALTER TABLE sheet_clone_memos RENAME COLUMN report_id TO sheet_clone_id;
DROP INDEX report_documents_version_idx;
CREATE INDEX sheet_clone_documents_version_idx ON sheet_clone_documents(version_id);
DROP INDEX report_memos_version_idx;
CREATE INDEX sheet_clone_memos_version_idx ON sheet_clone_memos(version_id);
