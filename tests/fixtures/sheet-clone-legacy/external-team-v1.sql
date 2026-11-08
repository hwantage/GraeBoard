--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: graeboard; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA graeboard;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: connection_probes; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.connection_probes (
    id text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.schema_migrations (
    scope text NOT NULL,
    version integer NOT NULL,
    checksum text NOT NULL,
    applied_at text NOT NULL
);


--
-- Name: site_audit; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_audit (
    id text NOT NULL,
    team_id text NOT NULL,
    actor_id text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    payload text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: site_entities; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_entities (
    team_id text NOT NULL,
    entity text NOT NULL,
    entity_key text NOT NULL,
    payload text,
    revision bigint DEFAULT 0 NOT NULL,
    deleted integer DEFAULT 0 NOT NULL,
    CONSTRAINT site_entities_deleted_check CHECK ((deleted = ANY (ARRAY[0, 1]))),
    CONSTRAINT site_entities_revision_check CHECK ((revision >= 0))
);


--
-- Name: site_entity_revisions; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_entity_revisions (
    team_id text NOT NULL,
    entity text NOT NULL,
    entity_key text NOT NULL,
    revision bigint NOT NULL
);


--
-- Name: site_events; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_events (
    cursor bigint NOT NULL,
    team_id text NOT NULL,
    kind text NOT NULL,
    payload text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: site_events_cursor_seq; Type: SEQUENCE; Schema: graeboard; Owner: -
--

ALTER TABLE graeboard.site_events ALTER COLUMN cursor ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graeboard.site_events_cursor_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: site_maintenance_jobs; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_maintenance_jobs (
    job_id text NOT NULL,
    team_id text NOT NULL,
    kind text NOT NULL,
    phase text NOT NULL,
    manifest text NOT NULL,
    progress text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: site_operations; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_operations (
    team_id text NOT NULL,
    op_id text NOT NULL,
    actor_id text NOT NULL,
    request_hash text NOT NULL,
    response text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: site_retention; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.site_retention (
    team_id text NOT NULL,
    site_id text NOT NULL,
    kind text NOT NULL,
    entity_key text NOT NULL,
    generation text DEFAULT ''::text NOT NULL,
    revision bigint NOT NULL,
    created_at text NOT NULL
);


--
-- Name: sync_conflicts; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_conflicts (
    team_id text NOT NULL,
    conflict_id text NOT NULL,
    op_id text NOT NULL,
    payload text NOT NULL,
    resolution text
);


--
-- Name: sync_entities; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_entities (
    team_id text NOT NULL,
    entity text NOT NULL,
    entity_key text NOT NULL,
    generation text NOT NULL,
    version text NOT NULL,
    payload text,
    deleted integer DEFAULT 0 NOT NULL
);


--
-- Name: sync_objects; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_objects (
    team_id text NOT NULL,
    hash text NOT NULL,
    kind text NOT NULL,
    data bytea NOT NULL,
    size integer NOT NULL,
    CONSTRAINT sync_objects_size_check CHECK ((size >= 0))
);


--
-- Name: sync_outbox; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_outbox (
    local_seq bigint NOT NULL,
    op_id text NOT NULL,
    team_id text NOT NULL,
    payload text NOT NULL,
    payload_hash text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT sync_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'acknowledged'::text, 'held'::text])))
);


--
-- Name: sync_outbox_local_seq_seq; Type: SEQUENCE; Schema: graeboard; Owner: -
--

ALTER TABLE graeboard.sync_outbox ALTER COLUMN local_seq ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME graeboard.sync_outbox_local_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sync_person_refs; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_person_refs (
    team_id text NOT NULL,
    person_id text NOT NULL,
    profile text NOT NULL,
    local_user_id text
);


--
-- Name: sync_receipts; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.sync_receipts (
    team_id text NOT NULL,
    op_id text NOT NULL,
    payload_hash text NOT NULL,
    result text NOT NULL,
    commit_oid text,
    receipt text NOT NULL
);


--
-- Name: team_meta; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.team_meta (
    singleton integer NOT NULL,
    team_id text NOT NULL,
    CONSTRAINT team_meta_singleton_check CHECK ((singleton = 1))
);


--
-- Name: team_sync_links; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.team_sync_links (
    team_id text NOT NULL,
    repo_id text NOT NULL,
    bootstrap_id text NOT NULL,
    installation_id text NOT NULL,
    writer_epoch text NOT NULL,
    profile_id text NOT NULL,
    mode text NOT NULL,
    canonical_head text,
    canonical_hash text,
    generation bigint DEFAULT 0 NOT NULL,
    last_received_at text,
    last_published_at text,
    last_error text,
    remote_status text,
    bootstrap_bundle text,
    lease_owner text,
    lease_until bigint,
    updated_at text NOT NULL,
    CONSTRAINT team_sync_links_mode_check CHECK ((mode = ANY (ARRAY['initializing'::text, 'importing'::text, 'active'::text, 'paused'::text, 'recovery'::text, 'disconnected'::text])))
);


--
-- Name: teams; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.teams (
    id text NOT NULL,
    name text NOT NULL,
    settings text NOT NULL
);


--
-- Data for Name: connection_probes; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.schema_migrations VALUES ('team', 1, 'fa8f2cbdd8db268cc984ea3a516a67ec21b068482cccc665834dd380a2b9c2e3', '2026-11-07T16:37:15.190Z');
INSERT INTO graeboard.schema_migrations VALUES ('team', 2, 'ceb14347ad6c7a237694b61202f4384bc07aaf08e7c6998f0c325adc10228acc', '2026-11-07T16:37:15.190Z');


--
-- Data for Name: site_audit; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.site_audit VALUES ('d8965564-156a-45a8-9c2d-3c471654cb22', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'report', '["person",["897806d1-39e9-4732-a768-e5f8ac7f7631"]]', '[{"after":{"count":1,"name":"외부에서 만든 사본"},"before":null,"entity":"report","key":["2421b8fe-434d-44b4-aad3-7f6a12806694"]}]', '2026-11-07T16:37:19.138Z');
INSERT INTO graeboard.site_audit VALUES ('46473e42-24fe-4ab9-bef5-37bc7bfe0ff2', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'report-edit', '["document",["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]]', '[{"after":{"markdown":"","position":0,"title":"문서 1"},"before":null,"entity":"document","key":["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"after":{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"2026-10-19":{"style":{},"value":"외부 사본 셀","version":1},"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:19.141Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026},"before":{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026},"entity":"report","key":["75aea1f4-dc09-4cff-adb0-fea228d788e7"]}]', '2026-11-07T16:37:19.188Z');
INSERT INTO graeboard.site_audit VALUES ('a7b1b3e5-3252-42df-ad1a-5d63ee1dfffa', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'document', '["document",["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]]', '[{"after":{"markdown":"외부 사본 문서 [첫 사본](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)","position":0,"title":"문서 1"},"before":{"markdown":"# 링크 모음\n\n사본 업무: [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n사본 메모: [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n전체 화면: [전체](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf?view=full)\n조각: [조각](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452#section)\n사내 절대 주소: [절대](https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n외부 자동 링크: <https://graeboard-external.example.com/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452>\n리터럴 자동 링크: https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55\n무관한 사이트: [무관](https://unrelated.example.org/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n참조형: [참조 링크][ref-copy]\n삭제된 사본: [삭제](/links/report-task/99fd95d2-3e1b-487e-95d3-928042c542ec/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n원본 업무: [업무](/links/task/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf) 메모: [메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452)\n문장 속 report-task 와 /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf 는 링크가 아니다.\n인라인 코드 `/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452`\n\n```text\n[코드 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n```\n\n<details open>\n<summary><h2>[토글 제목](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)</h2></summary>\n\n토글 안 [메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n\n</details>\n\n<a href=\"/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452\">HTML 링크</a>\n\n| 표 | 링크 |\n| --- | --- |\n| 셀 | [표 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9) |\n\n![그림](/api/document-images/377e8e56-aea7-46ea-a51e-0715b9b79ca3/c3d892480da73b63c59bbdd1a3026d5671fb2c4f5144dc3d37d5c54ae3f84d02.webp)\n\n[ref-copy]: /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55 \"참조 제목\"\n","position":0,"title":"문서 1"},"entity":"document","key":["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]}]', '2026-11-07T16:37:19.232Z');
INSERT INTO graeboard.site_audit VALUES ('833f9ac1-a9e1-406a-9dad-b0e30d843976', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'report-edit', '["document",["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]]', '[{"after":{"markdown":"","position":0,"title":"문서 1"},"before":null,"entity":"document","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"after":{"markdown":"","position":0,"title":"문서 1"},"before":null,"entity":"document","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]},{"after":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"외부에서 나중","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:23.285Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"before":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"entity":"report","key":["4629aad6-5a63-4cff-8c9f-da950189868b"]}]', '2026-11-07T16:37:23.331Z');


--
-- Data for Name: site_entities; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'calendar', '["b10727a3-443f-465d-a7ef-e1e833dc451a"]', '{"date":"2026-10-07","deletedAt":null,"endDate":"2026-10-07","lane":0,"tags":[],"title":"일정 문서","userId":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","2026-10-05"]', '{"style":{},"value":"일정"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","title"]', '{"style":{},"value":"원본 업무 하나"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","2026-10-12"]', '{"style":{"backgroundColor":"#ddeeff","bold":true},"value":"주간 계획"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","title"]', '{"style":{},"value":"원본 업무 둘"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9","title"]', '{"style":{},"value":"원본 업무 셋"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","5f1a5c88-64ee-4e1f-902e-f06435569452"]', '{"markdown":"연간 메모 본문 [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"연간 메모"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', '{"markdown":"두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":1,"title":"두 번째 메모"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["calendar","b10727a3-443f-465d-a7ef-e1e833dc451a","main"]', '{"markdown":"일정 본문 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452) 와 [업무](/links/task/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"일정 문서"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '{"markdown":"사본에서 고친 문서 [다음 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452) [자기](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '{"markdown":"사본에서 고친 문서 [다음 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452) [자기](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","4629aad6-5a63-4cff-8c9f-da950189868b","5f1a5c88-64ee-4e1f-902e-f06435569452"]', '{"markdown":"사본 메모 본문 [원본 메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452) [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"연간 메모"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","75aea1f4-dc09-4cff-adb0-fea228d788e7","5f1a5c88-64ee-4e1f-902e-f06435569452"]', '{"markdown":"사본 메모 본문 [원본 메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452) [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"연간 메모"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '{"markdown":"# 링크 모음\n\n사본 업무: [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n사본 메모: [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n전체 화면: [전체](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf?view=full)\n조각: [조각](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452#section)\n사내 절대 주소: [절대](https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n외부 자동 링크: <https://graeboard-external.example.com/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452>\n리터럴 자동 링크: https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55\n무관한 사이트: [무관](https://unrelated.example.org/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n참조형: [참조 링크][ref-copy]\n삭제된 사본: [삭제](/links/report-task/99fd95d2-3e1b-487e-95d3-928042c542ec/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n원본 업무: [업무](/links/task/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf) 메모: [메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452)\n문장 속 report-task 와 /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf 는 링크가 아니다.\n인라인 코드 `/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452`\n\n```text\n[코드 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n```\n\n<details open>\n<summary><h2>[토글 제목](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)</h2></summary>\n\n토글 안 [메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n\n</details>\n\n<a href=\"/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452\">HTML 링크</a>\n\n| 표 | 링크 |\n| --- | --- |\n| 셀 | [표 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9) |\n\n![그림](/api/document-images/377e8e56-aea7-46ea-a51e-0715b9b79ca3/c3d892480da73b63c59bbdd1a3026d5671fb2c4f5144dc3d37d5c54ae3f84d02.webp)\n\n[ref-copy]: /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55 \"참조 제목\"\n","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","9fceed84-e299-420a-9dcf-1978217c9a55","main"]', '{"markdown":"원본 둘의 공유 문서: [사본 셋째 행](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'formats', '[]', '{"rules":[]}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["5649b75e-6ec5-483e-8fbf-e2a2751a4eb5"]', '{"name":"팀원"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["7ba14b00-2d4f-4b4a-8397-4d17aa3df01e"]', '{"name":"팀장"}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'syncRefresh', '[]', '{"nextAt":1794069469083,"publishAfter":1794069452342}', 0, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["e8f06ae1-51d4-4f16-ac61-a881b2bebe70"]', '{"createdAt":"2026-11-07T16:37:15.491Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.491Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"id":"5a3a9465-6684-5518-a1b5-081d2850ce7f","position":2,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.491Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"가져온 시트","referenceDate":"2026-10-11","year":2026}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'team', '[]', '{"name":"사본 전환 fixture","settings":{"defaultDensity":"compact","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"}}', 1794069437560, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf"]', '{"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":100,"rowStyle":{},"years":[2026]}', 1794069437561, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["9fceed84-e299-420a-9dcf-1978217c9a55"]', '{"createdAt":"2026-11-07T16:37:15.229Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":200,"rowStyle":{},"years":[2026]}', 1794069437561, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9"]', '{"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":300,"rowStyle":{},"years":[2026]}', 1794069437561, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["897806d1-39e9-4732-a768-e5f8ac7f7631"]', '{"name":"외부 관리자"}', 1794069439130, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","5f1a5c88-64ee-4e1f-902e-f06435569452"]', '{"markdown":"연간 메모 본문 [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"연간 메모"}', 1794069439133, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', '{"markdown":"두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":1,"title":"두 번째 메모"}', 1794069439133, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["2421b8fe-434d-44b4-aad3-7f6a12806694"]', '{"createdAt":"2026-11-07T16:37:19.133Z","createdBy":"897806d1-39e9-4732-a768-e5f8ac7f7631","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"revision":1794069437560,"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1794069437560},"title":{"style":{},"value":"원본 업무 하나","version":1794069437560}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"formatting":{"$f":0},"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"rowStyle":{},"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:17.561Z","years":[2026]}],"users":[{"id":"5649b75e-6ec5-483e-8fbf-e2a2751a4eb5","name":"팀원"},{"id":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","name":"팀장"},{"id":"897806d1-39e9-4732-a768-e5f8ac7f7631","name":"외부 관리자"}],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$formats":[{"revision":1794069437560,"rules":[]}],"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"외부에서 만든 사본","referenceDate":"2026-10-10","year":2026}', 1794069439133, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]', '{"markdown":"","position":0,"title":"문서 1"}', 1794069439184, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["75aea1f4-dc09-4cff-adb0-fea228d788e7"]', '{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"2026-10-19":{"style":{},"value":"외부 사본 셀","version":1},"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:19.141Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026}', 1794069439185, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '{"markdown":"외부 사본 문서 [첫 사본](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)","position":0,"title":"문서 1"}', 1794069439229, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]', '{"markdown":"","position":0,"title":"문서 1"}', 1794069443327, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]', '{"markdown":"","position":0,"title":"문서 1"}', 1794069443328, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'syncTotals', '[]', '{"entities":34,"head":"9807efb3ee645f0d24df40e6ccdf36a181e10fc0","receiptBytes":2564,"stateBytes":43849,"sum":"7fab2660361b3e210d4c94e56fac9de55473e2c7ce5bd823b4cc9ff914dc2740"}', 0, 0);
INSERT INTO graeboard.site_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["4629aad6-5a63-4cff-8c9f-da950189868b"]', '{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사내에서 먼저","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:22.858Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"hasDocument":false,"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026}', 1794069443463, 0);


--
-- Data for Name: site_entity_revisions; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'calendar', '["b10727a3-443f-465d-a7ef-e1e833dc451a"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","2026-10-05"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","title"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","2026-10-12"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","title"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9","title"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["calendar","b10727a3-443f-465d-a7ef-e1e833dc451a","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","4629aad6-5a63-4cff-8c9f-da950189868b","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","75aea1f4-dc09-4cff-adb0-fea228d788e7","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","9fceed84-e299-420a-9dcf-1978217c9a55","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'formats', '[]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["5649b75e-6ec5-483e-8fbf-e2a2751a4eb5"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["7ba14b00-2d4f-4b4a-8397-4d17aa3df01e"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["e8f06ae1-51d4-4f16-ac61-a881b2bebe70"]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'team', '[]', 1794069437560);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf"]', 1794069437561);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["9fceed84-e299-420a-9dcf-1978217c9a55"]', 1794069437561);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9"]', 1794069437561);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["897806d1-39e9-4732-a768-e5f8ac7f7631"]', 1794069439130);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 1794069439133);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', 1794069439133);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["2421b8fe-434d-44b4-aad3-7f6a12806694"]', 1794069439133);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]', 1794069439184);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["75aea1f4-dc09-4cff-adb0-fea228d788e7"]', 1794069439185);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 1794069439229);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]', 1794069443327);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]', 1794069443328);
INSERT INTO graeboard.site_entity_revisions VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["4629aad6-5a63-4cff-8c9f-da950189868b"]', 1794069443463);


--
-- Data for Name: site_events; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (1, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"source":"sync","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:17.564Z');
INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (2, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"actorId":"897806d1-39e9-4732-a768-e5f8ac7f7631","entities":[{"entity":"person","key":["897806d1-39e9-4732-a768-e5f8ac7f7631"]},{"entity":"document","key":["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]},{"entity":"document","key":["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","5f1a5c88-64ee-4e1f-902e-f06435569452"]},{"entity":"document","key":["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]},{"entity":"report","key":["2421b8fe-434d-44b4-aad3-7f6a12806694"]}],"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:19.139Z');
INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (3, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"actorId":"897806d1-39e9-4732-a768-e5f8ac7f7631","entities":[{"entity":"document","key":["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"entity":"report","key":["75aea1f4-dc09-4cff-adb0-fea228d788e7"]}],"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:19.189Z');
INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (4, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"actorId":"897806d1-39e9-4732-a768-e5f8ac7f7631","entities":[{"entity":"document","key":["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]}],"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:19.232Z');
INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (5, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"actorId":"897806d1-39e9-4732-a768-e5f8ac7f7631","entities":[{"entity":"document","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"entity":"document","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]},{"entity":"report","key":["4629aad6-5a63-4cff-8c9f-da950189868b"]}],"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:23.332Z');
INSERT INTO graeboard.site_events OVERRIDING SYSTEM VALUE VALUES (6, '377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'changed', '{"source":"sync","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3"}', '2026-11-07T16:37:23.464Z');


--
-- Data for Name: site_maintenance_jobs; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: site_operations; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.site_operations VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report-create:2421b8fe-434d-44b4-aad3-7f6a12806694', '897806d1-39e9-4732-a768-e5f8ac7f7631', '25c824215594edacff10377727b4d0ef0c3a0c417e8e49f5466fa5c5bf26d0bf', '{"id":"2421b8fe-434d-44b4-aad3-7f6a12806694"}', '2026-11-07T16:37:19.139Z');
INSERT INTO graeboard.site_operations VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'e417041d-07a4-4651-a7d5-2d1190234feb', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'fcc5b095e044ac6b82f740f73779918f85d6e90fee298fbc3916367cc33baf89', '{"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}],"$data":{"id":"75aea1f4-dc09-4cff-adb0-fea228d788e7","name":"첫 사본 이름 변경","year":2026,"referenceDate":"2026-10-10","createdAt":"2026-11-07T16:37:15.351Z","settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1},"2026-10-19":{"value":"외부 사본 셀","style":{},"version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:19.141Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026},"revision":"1bb3643bc9028e5dfd941bb04415a8f94a13190e16bc74d6533313f85a121176"}}', '2026-11-07T16:37:19.189Z');
INSERT INTO graeboard.site_operations VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '11769536-50c8-42ca-b011-ae7d73cdccbc', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'df346612e18e1fec5426b6e06d2f2a5c44a8a96a23867714bb4f86ebae7e5198', '{"id":"main","title":"문서 1","markdown":"외부 사본 문서 [첫 사본](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)","revision":1794069439229,"updatedAt":"2026-11-07T16:37:19.229Z","sync":{"session":"postgres","sequence":1794069439229},"documents":[{"id":"main","title":"문서 1","revision":1794069439229,"hasContent":true,"updatedAt":"2026-11-07T16:37:19.229Z"}],"documentCount":1,"hasDocument":true}', '2026-11-07T16:37:19.232Z');
INSERT INTO graeboard.site_operations VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '3df353e3-a33d-4c6b-9532-e222b62051ba', '897806d1-39e9-4732-a768-e5f8ac7f7631', 'd1b4647998b59db0b4c1abf7e65cfbd0a1a5835371f4f5720fe7fbebe6c4b881', '{"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}],"$data":{"id":"4629aad6-5a63-4cff-8c9f-da950189868b","name":"다시 복사한 사본","year":2026,"referenceDate":"2026-10-10","createdAt":"2026-11-07T16:37:15.412Z","settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"value":"외부에서 나중","style":{},"version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:23.285Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026],"hasDocument":false}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026},"revision":"8d8ec0d8c96ed4553087ba78a49cf8a9fad49b5436f8cff8911af0118c91b46f"}}', '2026-11-07T16:37:23.332Z');


--
-- Data for Name: site_retention; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: sync_conflicts; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.sync_conflicts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '774f2933-d96c-40bb-9b3f-1c1b7ca59494', '774f2933-d96c-40bb-9b3f-1c1b7ca59494', '{"conflictId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","current":{"[\"document\",[\"report\",\"4629aad6-5a63-4cff-8c9f-da950189868b\",\"07437e22-95ab-5788-aacd-9909cc724ca3\",\"main\"]]":null,"[\"document\",[\"report\",\"4629aad6-5a63-4cff-8c9f-da950189868b\",\"1d5bcebe-8862-446c-ab07-22c96230f2ea\",\"main\"]]":null,"[\"report\",[\"4629aad6-5a63-4cff-8c9f-da950189868b\"]]":{"deleted":false,"entity":"report","generation":"1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587","key":["4629aad6-5a63-4cff-8c9f-da950189868b"],"payload":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사내에서 먼저","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:22.858Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"hasDocument":false,"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"version":"ea1fd772-0766-4e89-b514-0ee6a4c7dd38:0"}},"opId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","operation":{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"","position":0,"title":"문서 1"},"entity":"document","fields":["title","position","markdown"],"generation":"58bda6a4-c662-4152-ba31-527166fabd28","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"","position":0,"title":"문서 1"},"entity":"document","fields":["title","position","markdown"],"generation":"b871e98f-8374-474f-b74b-d86d86a3f112","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]},{"action":"edit","base":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"baseVersion":"1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587","desired":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"외부에서 나중","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:23.285Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"entity":"report","fields":["data"],"generation":"1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587","key":["4629aad6-5a63-4cff-8c9f-da950189868b"]}],"createdAt":"2026-11-07T16:37:23.330Z","dependsOn":[],"objects":[],"opId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"},"reason":"Concurrent field change","resolution":"2b995f56-ab4a-414c-9a0a-63e6c3e43cae"}', '2b995f56-ab4a-414c-9a0a-63e6c3e43cae');


--
-- Data for Name: sync_entities; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'calendar', '["b10727a3-443f-465d-a7ef-e1e833dc451a"]', 'cd85dd30f4461309fdb3900538232c03f3f39e648792cbad9342fdaafc5a7e34', 'cd85dd30f4461309fdb3900538232c03f3f39e648792cbad9342fdaafc5a7e34', '{"date":"2026-10-07","deletedAt":null,"endDate":"2026-10-07","lane":0,"tags":[],"title":"일정 문서","userId":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","2026-10-05"]', 'd1ea698b562c7e05954d6c592deb6eef9326c8583412a1791021b1c86b71ca2f', 'd1ea698b562c7e05954d6c592deb6eef9326c8583412a1791021b1c86b71ca2f', '{"style":{},"value":"일정"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","title"]', '05f619526759274f94af9691a40c5190abfd268bf3463fa5057ab91b1b04c571', '05f619526759274f94af9691a40c5190abfd268bf3463fa5057ab91b1b04c571', '{"style":{},"value":"원본 업무 하나"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","2026-10-12"]', '0953264b59532b9320a5a5c0f53c731bf11af5d183a04ad25cb9b3777de9045b', '0953264b59532b9320a5a5c0f53c731bf11af5d183a04ad25cb9b3777de9045b', '{"style":{"backgroundColor":"#ddeeff","bold":true},"value":"주간 계획"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["9fceed84-e299-420a-9dcf-1978217c9a55","title"]', 'da9f3745156b4c31bc42fcdbc35c5a68262d38b6492d0375e550179a41c23831', 'da9f3745156b4c31bc42fcdbc35c5a68262d38b6492d0375e550179a41c23831', '{"style":{},"value":"원본 업무 둘"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'cell', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9","title"]', '58efdb48f155c5d65059af1bee596661675ba802f23694cb75dfef739ac98452', '58efdb48f155c5d65059af1bee596661675ba802f23694cb75dfef739ac98452', '{"style":{},"value":"원본 업무 셋"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","5f1a5c88-64ee-4e1f-902e-f06435569452"]', '7d621e5ca505e8dec0dd160771aee0d3bc82dacd45c36efd0abda899f8105458', '7d621e5ca505e8dec0dd160771aee0d3bc82dacd45c36efd0abda899f8105458', '{"markdown":"연간 메모 본문 [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"연간 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["annual","2026","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', '2f3b5de3c1b863765a344ef6aa79451e53109b1cdfe620729b78a2c1dcaa5bc6', '2f3b5de3c1b863765a344ef6aa79451e53109b1cdfe620729b78a2c1dcaa5bc6', '{"markdown":"두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":1,"title":"두 번째 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["calendar","b10727a3-443f-465d-a7ef-e1e833dc451a","main"]', '19eabb8b267f7cf086f1705fad492deb63b4bb61caa40d8cf9ab93f3223e8545', '19eabb8b267f7cf086f1705fad492deb63b4bb61caa40d8cf9ab93f3223e8545', '{"markdown":"일정 본문 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452) 와 [업무](/links/task/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"일정 문서"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '6e8ac5436d1612dbd95189bc7b1f756699c138629addfe5d5242d2582d45014e', '6e8ac5436d1612dbd95189bc7b1f756699c138629addfe5d5242d2582d45014e', '{"markdown":"사본에서 고친 문서 [다음 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452) [자기](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","4629aad6-5a63-4cff-8c9f-da950189868b","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', 'cad8c87a33d7e1c04fb4053693e4a50091195147c5b93de738e241e146d8d2f7', 'cad8c87a33d7e1c04fb4053693e4a50091195147c5b93de738e241e146d8d2f7', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 'e00ca7a2defa19e3843803e768bbbd309b30ee42f69c59011e93c4eaa92e148a', 'e00ca7a2defa19e3843803e768bbbd309b30ee42f69c59011e93c4eaa92e148a', '{"markdown":"사본에서 고친 문서 [다음 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452) [자기](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', '6e9c94fa62d29c77398abef8ee7ab13e6a96faa83fccdd59d85ebe361552e0c2', '6e9c94fa62d29c77398abef8ee7ab13e6a96faa83fccdd59d85ebe361552e0c2', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","4629aad6-5a63-4cff-8c9f-da950189868b","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 'b19611d4f1e131573f2676f002037cef716ff004de34dfafcfb0b526e3c1bbec', 'b19611d4f1e131573f2676f002037cef716ff004de34dfafcfb0b526e3c1bbec', '{"markdown":"사본 메모 본문 [원본 메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452) [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"연간 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","75aea1f4-dc09-4cff-adb0-fea228d788e7","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 'd74acdbe06416125383249f5f3a207dc5e536a1c7c014120d54b392bcc7cafb0', 'd74acdbe06416125383249f5f3a207dc5e536a1c7c014120d54b392bcc7cafb0', '{"markdown":"사본 메모 본문 [원본 메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452) [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/1d5bcebe-8862-446c-ab07-22c96230f2ea)","position":0,"title":"연간 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf"]', '13c562cec0c86ee98fe873eb6b5a420ce5154ccd37f1f5f16ee09d2fc54c84fa', '13c562cec0c86ee98fe873eb6b5a420ce5154ccd37f1f5f16ee09d2fc54c84fa', '{"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":100,"rowStyle":{},"years":[2026]}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["9fceed84-e299-420a-9dcf-1978217c9a55"]', '1624ad96843cc1d06bf15ffc57e94b60f0a1078b381a264f088ace481b853024', '1624ad96843cc1d06bf15ffc57e94b60f0a1078b381a264f088ace481b853024', '{"createdAt":"2026-11-07T16:37:15.229Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":200,"rowStyle":{},"years":[2026]}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', 'e41ddd2ad8d7074901337010e8ce150f013325105dce537a6a3cdde81bf3e565', 'e41ddd2ad8d7074901337010e8ce150f013325105dce537a6a3cdde81bf3e565', '{"markdown":"# 링크 모음\n\n사본 업무: [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n사본 메모: [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n전체 화면: [전체](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf?view=full)\n조각: [조각](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452#section)\n사내 절대 주소: [절대](https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n외부 자동 링크: <https://graeboard-external.example.com/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452>\n리터럴 자동 링크: https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55\n무관한 사이트: [무관](https://unrelated.example.org/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n참조형: [참조 링크][ref-copy]\n삭제된 사본: [삭제](/links/report-task/99fd95d2-3e1b-487e-95d3-928042c542ec/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n원본 업무: [업무](/links/task/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf) 메모: [메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452)\n문장 속 report-task 와 /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf 는 링크가 아니다.\n인라인 코드 `/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452`\n\n```text\n[코드 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n```\n\n<details open>\n<summary><h2>[토글 제목](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)</h2></summary>\n\n토글 안 [메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n\n</details>\n\n<a href=\"/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452\">HTML 링크</a>\n\n| 표 | 링크 |\n| --- | --- |\n| 셀 | [표 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9) |\n\n![그림](/api/document-images/377e8e56-aea7-46ea-a51e-0715b9b79ca3/c3d892480da73b63c59bbdd1a3026d5671fb2c4f5144dc3d37d5c54ae3f84d02.webp)\n\n[ref-copy]: /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55 \"참조 제목\"\n","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","9fceed84-e299-420a-9dcf-1978217c9a55","main"]', 'ba48f261775be4b7933899ffdf33d55cd4165feb3bf38a5e13f29d7a0bc33c84', 'ba48f261775be4b7933899ffdf33d55cd4165feb3bf38a5e13f29d7a0bc33c84', '{"markdown":"원본 둘의 공유 문서: [사본 셋째 행](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["task","c6af78c3-1be5-4633-b6ea-f835c44b90e9","main"]', '6dc93deb25eba68e404faeb57b396b4b0961bd880d992fc8001904706eb0ecfb', '6dc93deb25eba68e404faeb57b396b4b0961bd880d992fc8001904706eb0ecfb', '{"markdown":"셋째 업무 문서 [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'formats', '[]', '32c79d9352b39afc1545ecceb9839a8b553ae221b585c9803804fcca4de4e433', '32c79d9352b39afc1545ecceb9839a8b553ae221b585c9803804fcca4de4e433', '{"rules":[]}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["5649b75e-6ec5-483e-8fbf-e2a2751a4eb5"]', 'b54383ead0afbf5f59378287776738b4907f4aacc522166a7883ac986c52ae09', 'b54383ead0afbf5f59378287776738b4907f4aacc522166a7883ac986c52ae09', '{"name":"팀원"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["7ba14b00-2d4f-4b4a-8397-4d17aa3df01e"]', '46056b5339999477ddcf7c2b50e98a2a84194943ba9901020b095cf8a6608d26', '46056b5339999477ddcf7c2b50e98a2a84194943ba9901020b095cf8a6608d26', '{"name":"팀장"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["e8f06ae1-51d4-4f16-ac61-a881b2bebe70"]', 'df169400ae5e0a2fa26a83a61801efc7106e03e7ff54c16b7d9e8d0f5107d36d', 'df169400ae5e0a2fa26a83a61801efc7106e03e7ff54c16b7d9e8d0f5107d36d', '{"createdAt":"2026-11-07T16:37:15.491Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.491Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"id":"5a3a9465-6684-5518-a1b5-081d2850ce7f","position":2,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.491Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"가져온 시트","referenceDate":"2026-10-11","year":2026}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["4629aad6-5a63-4cff-8c9f-da950189868b"]', '1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587', 'ea1fd772-0766-4e89-b514-0ee6a4c7dd38:0', '{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사내에서 먼저","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:22.858Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"hasDocument":false,"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'task', '["c6af78c3-1be5-4633-b6ea-f835c44b90e9"]', '45ea62ac2cb132b928fea851fd15c88354e3ad5e4111a42fe72441043ee44647', '45ea62ac2cb132b928fea851fd15c88354e3ad5e4111a42fe72441043ee44647', '{"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"deletedAt":null,"position":300,"rowStyle":{},"years":[2026]}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'team', '[]', '4b4397d2a138a4639da659d589b87102cc732e67cbb8fb0bbdf89887d524c9a3', '4b4397d2a138a4639da659d589b87102cc732e67cbb8fb0bbdf89887d524c9a3', '{"name":"사본 전환 fixture","settings":{"defaultDensity":"compact","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"}}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["75aea1f4-dc09-4cff-adb0-fea228d788e7"]', 'f6e85c2454cb3c8465b8d2436a04c84c5b83eba42d8ab1fb2824cc936a9ca3dd', '7eca6a38-f363-427b-a873-b2023c2f94e3:1', '{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"2026-10-19":{"style":{},"value":"외부 사본 셀","version":1},"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:19.141Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'person', '["897806d1-39e9-4732-a768-e5f8ac7f7631"]', '031a61ee-2eb4-4054-b47f-6bc7120833ae', '1361aff0-7d20-48fd-b539-4e67fd4c4949:0', '{"name":"외부 관리자"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]', '82c5c69c-05bb-4278-b28d-534997c6a1b1', 'fa4b4491-c3be-44e3-b000-f15f431e526f:0', '{"markdown":"외부 사본 문서 [첫 사본](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)","position":0,"title":"문서 1"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","5f1a5c88-64ee-4e1f-902e-f06435569452"]', 'fa9156b4-53ef-445a-9bf6-32a2fc46d16a', '1361aff0-7d20-48fd-b539-4e67fd4c4949:2', '{"markdown":"연간 메모 본문 [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"연간 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]', '0b31031a-7fec-4644-a50d-0103bcc015a3', '1361aff0-7d20-48fd-b539-4e67fd4c4949:3', '{"markdown":"두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":1,"title":"두 번째 메모"}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'report', '["2421b8fe-434d-44b4-aad3-7f6a12806694"]', 'e7aeeca5-e339-443b-a9b7-aa6f439b65d2', '1361aff0-7d20-48fd-b539-4e67fd4c4949:4', '{"createdAt":"2026-11-07T16:37:19.133Z","createdBy":"897806d1-39e9-4732-a768-e5f8ac7f7631","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"revision":1794069437560,"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1794069437560},"title":{"style":{},"value":"원본 업무 하나","version":1794069437560}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"formatting":{"$f":0},"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"rowStyle":{},"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:17.561Z","years":[2026]}],"users":[{"id":"5649b75e-6ec5-483e-8fbf-e2a2751a4eb5","name":"팀원"},{"id":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","name":"팀장"},{"id":"897806d1-39e9-4732-a768-e5f8ac7f7631","name":"외부 관리자"}],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$formats":[{"revision":1794069437560,"rules":[]}],"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"외부에서 만든 사본","referenceDate":"2026-10-10","year":2026}', 0);
INSERT INTO graeboard.sync_entities VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'document', '["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]', 'dc168660-97d0-4b29-9624-6562d55f01ec', '7eca6a38-f363-427b-a873-b2023c2f94e3:0', '{"markdown":"","position":0,"title":"문서 1"}', 0);


--
-- Data for Name: sync_objects; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: sync_outbox; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.sync_outbox OVERRIDING SYSTEM VALUE VALUES (1, '1361aff0-7d20-48fd-b539-4e67fd4c4949', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[{"action":"create","base":null,"baseVersion":null,"desired":{"name":"외부 관리자"},"entity":"person","fields":["name"],"generation":"031a61ee-2eb4-4054-b47f-6bc7120833ae","key":["897806d1-39e9-4732-a768-e5f8ac7f7631"]},{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"# 링크 모음\n\n사본 업무: [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n사본 메모: [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n전체 화면: [전체](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf?view=full)\n조각: [조각](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452#section)\n사내 절대 주소: [절대](https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n외부 자동 링크: <https://graeboard-external.example.com/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452>\n리터럴 자동 링크: https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55\n무관한 사이트: [무관](https://unrelated.example.org/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n참조형: [참조 링크][ref-copy]\n삭제된 사본: [삭제](/links/report-task/99fd95d2-3e1b-487e-95d3-928042c542ec/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n원본 업무: [업무](/links/task/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf) 메모: [메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452)\n문장 속 report-task 와 /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf 는 링크가 아니다.\n인라인 코드 `/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452`\n\n```text\n[코드 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n```\n\n<details open>\n<summary><h2>[토글 제목](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)</h2></summary>\n\n토글 안 [메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n\n</details>\n\n<a href=\"/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452\">HTML 링크</a>\n\n| 표 | 링크 |\n| --- | --- |\n| 셀 | [표 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9) |\n\n![그림](/api/document-images/377e8e56-aea7-46ea-a51e-0715b9b79ca3/c3d892480da73b63c59bbdd1a3026d5671fb2c4f5144dc3d37d5c54ae3f84d02.webp)\n\n[ref-copy]: /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55 \"참조 제목\"\n","position":0,"title":"문서 1"},"entity":"document","fields":["markdown","position","title"],"generation":"82c5c69c-05bb-4278-b28d-534997c6a1b1","key":["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]},{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"연간 메모 본문 [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55)","position":0,"title":"연간 메모"},"entity":"document","fields":["markdown","position","title"],"generation":"fa9156b4-53ef-445a-9bf6-32a2fc46d16a","key":["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","5f1a5c88-64ee-4e1f-902e-f06435569452"]},{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"두 번째 메모 [다시 복사한 사본 메모](/links/report-memo/4629aad6-5a63-4cff-8c9f-da950189868b/5f1a5c88-64ee-4e1f-902e-f06435569452)","position":1,"title":"두 번째 메모"},"entity":"document","fields":["markdown","position","title"],"generation":"0b31031a-7fec-4644-a50d-0103bcc015a3","key":["reportMemo","2421b8fe-434d-44b4-aad3-7f6a12806694","e1a9322c-b1b7-4b76-92e1-1d3daf9e3137"]},{"action":"create","base":null,"baseVersion":null,"desired":{"createdAt":"2026-11-07T16:37:19.133Z","createdBy":"897806d1-39e9-4732-a768-e5f8ac7f7631","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"revision":1794069437560,"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1794069437560},"title":{"style":{},"value":"원본 업무 하나","version":1794069437560}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"formatting":{"$f":0},"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"rowStyle":{},"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:17.561Z","years":[2026]}],"users":[{"id":"5649b75e-6ec5-483e-8fbf-e2a2751a4eb5","name":"팀원"},{"id":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","name":"팀장"},{"id":"897806d1-39e9-4732-a768-e5f8ac7f7631","name":"외부 관리자"}],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$formats":[{"revision":1794069437560,"rules":[]}],"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"외부에서 만든 사본","referenceDate":"2026-10-10","year":2026},"entity":"report","fields":["year","name","referenceDate","createdBy","createdAt","data"],"generation":"e7aeeca5-e339-443b-a9b7-aa6f439b65d2","key":["2421b8fe-434d-44b4-aad3-7f6a12806694"]}],"createdAt":"2026-11-07T16:37:19.136Z","dependsOn":[],"objects":[],"opId":"1361aff0-7d20-48fd-b539-4e67fd4c4949","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"}', '4f83c77777348031f991c02efa99ceeb04d3252c2ed1363deaf0ca97c3d8dcec', 'acknowledged', '2026-11-07T16:37:19.136Z');
INSERT INTO graeboard.sync_outbox OVERRIDING SYSTEM VALUE VALUES (2, '7eca6a38-f363-427b-a873-b2023c2f94e3', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"","position":0,"title":"문서 1"},"entity":"document","fields":["title","position","markdown"],"generation":"dc168660-97d0-4b29-9624-6562d55f01ec","key":["report","75aea1f4-dc09-4cff-adb0-fea228d788e7","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"action":"edit","base":{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026},"baseVersion":"f6e85c2454cb3c8465b8d2436a04c84c5b83eba42d8ab1fb2824cc936a9ca3dd","desired":{"createdAt":"2026-11-07T16:37:15.351Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"2026-10-19":{"style":{},"value":"외부 사본 셀","version":1},"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:19.141Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"첫 사본 이름 변경","referenceDate":"2026-10-10","year":2026},"entity":"report","fields":["data"],"generation":"f6e85c2454cb3c8465b8d2436a04c84c5b83eba42d8ab1fb2824cc936a9ca3dd","key":["75aea1f4-dc09-4cff-adb0-fea228d788e7"]}],"createdAt":"2026-11-07T16:37:19.187Z","dependsOn":[],"objects":[],"opId":"7eca6a38-f363-427b-a873-b2023c2f94e3","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"}', 'd439cdf8dd6891283ccf0f76eb00229918874dcdcb3974d3c4a93aa0bd97bd01', 'acknowledged', '2026-11-07T16:37:19.187Z');
INSERT INTO graeboard.sync_outbox OVERRIDING SYSTEM VALUE VALUES (3, 'fa4b4491-c3be-44e3-b000-f15f431e526f', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[{"action":"edit","base":{"markdown":"# 링크 모음\n\n사본 업무: [사본 업무](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n사본 메모: [사본 메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n전체 화면: [전체](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf?view=full)\n조각: [조각](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452#section)\n사내 절대 주소: [절대](https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n외부 자동 링크: <https://graeboard-external.example.com/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452>\n리터럴 자동 링크: https://graeboard-internal.example.com/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55\n무관한 사이트: [무관](https://unrelated.example.org/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n참조형: [참조 링크][ref-copy]\n삭제된 사본: [삭제](/links/report-task/99fd95d2-3e1b-487e-95d3-928042c542ec/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n원본 업무: [업무](/links/task/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf) 메모: [메모](/links/memo/377e8e56-aea7-46ea-a51e-0715b9b79ca3/2026/5f1a5c88-64ee-4e1f-902e-f06435569452)\n문장 속 report-task 와 /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf 는 링크가 아니다.\n인라인 코드 `/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452`\n\n```text\n[코드 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)\n```\n\n<details open>\n<summary><h2>[토글 제목](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)</h2></summary>\n\n토글 안 [메모](/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452)\n\n</details>\n\n<a href=\"/links/report-memo/75aea1f4-dc09-4cff-adb0-fea228d788e7/5f1a5c88-64ee-4e1f-902e-f06435569452\">HTML 링크</a>\n\n| 표 | 링크 |\n| --- | --- |\n| 셀 | [표 안](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/c6af78c3-1be5-4633-b6ea-f835c44b90e9) |\n\n![그림](/api/document-images/377e8e56-aea7-46ea-a51e-0715b9b79ca3/c3d892480da73b63c59bbdd1a3026d5671fb2c4f5144dc3d37d5c54ae3f84d02.webp)\n\n[ref-copy]: /links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/9fceed84-e299-420a-9dcf-1978217c9a55 \"참조 제목\"\n","position":0,"title":"문서 1"},"baseVersion":"1361aff0-7d20-48fd-b539-4e67fd4c4949:1","desired":{"markdown":"외부 사본 문서 [첫 사본](/links/report-task/75aea1f4-dc09-4cff-adb0-fea228d788e7/0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf)","position":0,"title":"문서 1"},"entity":"document","fields":["markdown"],"generation":"82c5c69c-05bb-4278-b28d-534997c6a1b1","key":["report","2421b8fe-434d-44b4-aad3-7f6a12806694","0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","main"]}],"createdAt":"2026-11-07T16:37:19.231Z","dependsOn":["1361aff0-7d20-48fd-b539-4e67fd4c4949"],"objects":[],"opId":"fa4b4491-c3be-44e3-b000-f15f431e526f","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"}', '0be120ed71619401bc936033cce3fe210e6e82a98208af250e6e201223fb0d1f', 'acknowledged', '2026-11-07T16:37:19.231Z');
INSERT INTO graeboard.sync_outbox OVERRIDING SYSTEM VALUE VALUES (4, '774f2933-d96c-40bb-9b3f-1c1b7ca59494', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"","position":0,"title":"문서 1"},"entity":"document","fields":["title","position","markdown"],"generation":"58bda6a4-c662-4152-ba31-527166fabd28","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","1d5bcebe-8862-446c-ab07-22c96230f2ea","main"]},{"action":"create","base":null,"baseVersion":null,"desired":{"markdown":"","position":0,"title":"문서 1"},"entity":"document","fields":["title","position","markdown"],"generation":"b871e98f-8374-474f-b74b-d86d86a3f112","key":["report","4629aad6-5a63-4cff-8c9f-da950189868b","07437e22-95ab-5788-aacd-9909cc724ca3","main"]},{"action":"edit","base":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"사본에서 바꾼 제목","version":2}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.352Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"baseVersion":"1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587","desired":{"createdAt":"2026-11-07T16:37:15.412Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","data":{"$data":{"settings":{"defaultDensity":"compact","defaultStyle":{"$s":0},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"},"tasks":[{"cells":{"2026-10-05":{"style":{},"value":"일정","version":1},"title":{"style":{},"value":"외부에서 나중","version":3}},"createdAt":"2026-11-07T16:37:15.221Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf","position":100,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:23.285Z","years":[2026]},{"cells":{"owner":{"style":{},"value":"","version":1},"status":{"style":{},"value":"","version":1},"title":{"style":{},"value":"사본에서 추가한 행","version":1}},"createdAt":"2026-11-07T16:37:15.361Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":false,"id":"1d5bcebe-8862-446c-ab07-22c96230f2ea","position":400,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.361Z","years":[2026]},{"cells":{"title":{"style":{},"value":"원본 업무 셋","version":1}},"createdAt":"2026-11-07T16:37:15.233Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{"$s":0},"deletedAt":null,"documentCount":1,"documents":[{"id":"main","title":"문서 1"}],"hasDocument":true,"id":"c6af78c3-1be5-4633-b6ea-f835c44b90e9","position":300,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.398Z","years":[2026]},{"cells":{"2026-10-05":{"style":{},"value":"엑셀 일정","version":1},"title":{"style":{},"value":"엑셀 업무","version":1}},"createdAt":"2026-11-07T16:37:15.514Z","createdBy":"7ba14b00-2d4f-4b4a-8397-4d17aa3df01e","defaultStyle":{},"documentCount":0,"documents":[{"id":"main","title":"문서 1"}],"id":"07437e22-95ab-5788-aacd-9909cc724ca3","position":401,"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","updatedAt":"2026-11-07T16:37:15.514Z","years":[2026]}],"users":[],"view":{"collapsedMonths":[],"columnVisibility":{},"fromMonth":1,"fromWeek":"","frozenColumns":0,"groupBy":"","hiddenRows":[],"hiddenWeeks":[],"knownProperties":[],"propertyFilterModes":{},"propertyFilters":{},"rowHeights":{},"sortDirection":"default","sortKey":"","startMonth":1,"toMonth":12,"toWeek":"","visibleFields":["title","owner","status"],"widths":{},"year":2026}},"$styles":[{"ff":"Noto Sans KR","fs":9,"va":"middle"}]},"name":"다시 복사한 사본","referenceDate":"2026-10-10","year":2026},"entity":"report","fields":["data"],"generation":"1edddf92aaa2fab3153f69b4ba948c60f485b8801cde84546bbfca794ef05587","key":["4629aad6-5a63-4cff-8c9f-da950189868b"]}],"createdAt":"2026-11-07T16:37:23.330Z","dependsOn":[],"objects":[],"opId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"}', 'cea24e7134af4569f88a2b35d521eaaac394caf35bced3c448f9718cd77be176', 'acknowledged', '2026-11-07T16:37:23.330Z');
INSERT INTO graeboard.sync_outbox OVERRIDING SYSTEM VALUE VALUES (5, '2b995f56-ab4a-414c-9a0a-63e6c3e43cae', '377e8e56-aea7-46ea-a51e-0715b9b79ca3', '{"actorRef":"897806d1-39e9-4732-a768-e5f8ac7f7631","changes":[],"createdAt":"2026-11-07T16:37:25.332Z","dependsOn":[],"objects":[],"opId":"2b995f56-ab4a-414c-9a0a-63e6c3e43cae","protocol":1,"reducer":1,"repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","resolves":["774f2933-d96c-40bb-9b3f-1c1b7ca59494"],"teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","writerEpoch":"0e4f261d-de9c-465d-84bf-337206fd4851"}', '33b595e41ab812a3a2c2a571a377e8860aa5d192f8ad6f0acfdd65b5374222c6', 'acknowledged', '2026-11-07T16:37:25.332Z');


--
-- Data for Name: sync_person_refs; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: sync_receipts; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '1361aff0-7d20-48fd-b539-4e67fd4c4949', '4f83c77777348031f991c02efa99ceeb04d3252c2ed1363deaf0ca97c3d8dcec', 'applied', '73498ae4069ec2e5d3ff001c83997d84f5a3a8e8', '{"conflictId":null,"opId":"1361aff0-7d20-48fd-b539-4e67fd4c4949","outputTokens":{"[\"document\",[\"report\",\"2421b8fe-434d-44b4-aad3-7f6a12806694\",\"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf\",\"main\"]]":"1361aff0-7d20-48fd-b539-4e67fd4c4949:1","[\"document\",[\"reportMemo\",\"2421b8fe-434d-44b4-aad3-7f6a12806694\",\"5f1a5c88-64ee-4e1f-902e-f06435569452\"]]":"1361aff0-7d20-48fd-b539-4e67fd4c4949:2","[\"document\",[\"reportMemo\",\"2421b8fe-434d-44b4-aad3-7f6a12806694\",\"e1a9322c-b1b7-4b76-92e1-1d3daf9e3137\"]]":"1361aff0-7d20-48fd-b539-4e67fd4c4949:3","[\"person\",[\"897806d1-39e9-4732-a768-e5f8ac7f7631\"]]":"1361aff0-7d20-48fd-b539-4e67fd4c4949:0","[\"report\",[\"2421b8fe-434d-44b4-aad3-7f6a12806694\"]]":"1361aff0-7d20-48fd-b539-4e67fd4c4949:4"},"payloadHash":"4f83c77777348031f991c02efa99ceeb04d3252c2ed1363deaf0ca97c3d8dcec","result":"applied"}');
INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '7eca6a38-f363-427b-a873-b2023c2f94e3', 'd439cdf8dd6891283ccf0f76eb00229918874dcdcb3974d3c4a93aa0bd97bd01', 'applied', '73498ae4069ec2e5d3ff001c83997d84f5a3a8e8', '{"conflictId":null,"opId":"7eca6a38-f363-427b-a873-b2023c2f94e3","outputTokens":{"[\"document\",[\"report\",\"75aea1f4-dc09-4cff-adb0-fea228d788e7\",\"1d5bcebe-8862-446c-ab07-22c96230f2ea\",\"main\"]]":"7eca6a38-f363-427b-a873-b2023c2f94e3:0","[\"report\",[\"75aea1f4-dc09-4cff-adb0-fea228d788e7\"]]":"7eca6a38-f363-427b-a873-b2023c2f94e3:1"},"payloadHash":"d439cdf8dd6891283ccf0f76eb00229918874dcdcb3974d3c4a93aa0bd97bd01","result":"applied"}');
INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'fa4b4491-c3be-44e3-b000-f15f431e526f', '0be120ed71619401bc936033cce3fe210e6e82a98208af250e6e201223fb0d1f', 'applied', '73498ae4069ec2e5d3ff001c83997d84f5a3a8e8', '{"conflictId":null,"opId":"fa4b4491-c3be-44e3-b000-f15f431e526f","outputTokens":{"[\"document\",[\"report\",\"2421b8fe-434d-44b4-aad3-7f6a12806694\",\"0c32f14b-c8fa-4e6d-b6cb-b18c4396efaf\",\"main\"]]":"fa4b4491-c3be-44e3-b000-f15f431e526f:0"},"payloadHash":"0be120ed71619401bc936033cce3fe210e6e82a98208af250e6e201223fb0d1f","result":"applied"}');
INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', 'ea1fd772-0766-4e89-b514-0ee6a4c7dd38', '9cf683b6b6f022f09c0b4a0f44e313ee711861261d9dd6212a916772342564a0', 'applied', '80f4187c7f847e56622f6c984d9dc7d220a45943', '{"conflictId":null,"opId":"ea1fd772-0766-4e89-b514-0ee6a4c7dd38","outputTokens":{"[\"report\",[\"4629aad6-5a63-4cff-8c9f-da950189868b\"]]":"ea1fd772-0766-4e89-b514-0ee6a4c7dd38:0"},"payloadHash":"9cf683b6b6f022f09c0b4a0f44e313ee711861261d9dd6212a916772342564a0","result":"applied"}');
INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '774f2933-d96c-40bb-9b3f-1c1b7ca59494', 'cea24e7134af4569f88a2b35d521eaaac394caf35bced3c448f9718cd77be176', 'conflict', 'dba388e96f1696018ab178442c213f432ba8b20b', '{"conflictId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","opId":"774f2933-d96c-40bb-9b3f-1c1b7ca59494","outputTokens":{},"payloadHash":"cea24e7134af4569f88a2b35d521eaaac394caf35bced3c448f9718cd77be176","result":"conflict"}');
INSERT INTO graeboard.sync_receipts VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '2b995f56-ab4a-414c-9a0a-63e6c3e43cae', '33b595e41ab812a3a2c2a571a377e8860aa5d192f8ad6f0acfdd65b5374222c6', 'noop', '9807efb3ee645f0d24df40e6ccdf36a181e10fc0', '{"conflictId":null,"opId":"2b995f56-ab4a-414c-9a0a-63e6c3e43cae","outputTokens":{},"payloadHash":"33b595e41ab812a3a2c2a571a377e8860aa5d192f8ad6f0acfdd65b5374222c6","result":"noop"}');


--
-- Data for Name: team_meta; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.team_meta VALUES (1, '377e8e56-aea7-46ea-a51e-0715b9b79ca3');


--
-- Data for Name: team_sync_links; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.team_sync_links VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '819185e5-ea51-44fa-9ca5-497d62161b9e', 'aea23a4e-3e26-4d0f-9adc-cdbce50fbbe0', '7e73c189-c108-43cd-8e72-2bab6d273016', '0e4f261d-de9c-465d-84bf-337206fd4851', 'outside', 'paused', '9807efb3ee645f0d24df40e6ccdf36a181e10fc0', NULL, 5, '2026-11-07T16:37:27.512Z', '2026-11-07T16:37:27.512Z', NULL, '{"appliedCanonicalHead":"9807efb3ee645f0d24df40e6ccdf36a181e10fc0","capabilities":["sum-1"],"installationId":"bc03f151-47be-43c0-a087-8165a3e57849","mode":"active","observedAt":"2026-11-07T16:37:27.864Z","peerInstallationId":"7e73c189-c108-43cd-8e72-2bab6d273016","repoId":"819185e5-ea51-44fa-9ca5-497d62161b9e","teamId":"377e8e56-aea7-46ea-a51e-0715b9b79ca3","verified":true,"verifiedAgainstHead":"9807efb3ee645f0d24df40e6ccdf36a181e10fc0","writerEpoch":"adf08c34-aee8-471a-8b0d-1714708401d7"}', NULL, NULL, NULL, '2026-11-07T16:37:29.296Z');


--
-- Data for Name: teams; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.teams VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '사본 전환 fixture', '{"defaultDensity":"compact","defaultStyle":{"fontFamily":"Noto Sans KR","fontSize":9,"verticalAlign":"middle"},"properties":[{"display":"text","id":"title","kind":"text","name":"작업","placement":"beforeWeeks","values":[],"visible":true,"width":330},{"display":"avatar","id":"owner","kind":"member","multiple":false,"name":"팀원","placement":"beforeWeeks","values":[],"visible":true,"width":112},{"display":"dot","id":"status","kind":"option","name":"상태","placement":"beforeWeeks","values":[{"backgroundColor":"#eef2f7","dotColor":"#718096","emoji":"📅","id":"status-planned","label":"예정"},{"backgroundColor":"#eee8f7","dotColor":"#8a6baa","emoji":"🔎","id":"status-review","label":"검토 중"},{"backgroundColor":"#e7effb","dotColor":"#467fc1","emoji":"🔵","id":"status-progress","label":"진행 중"},{"backgroundColor":"#e4f2eb","dotColor":"#2f8a67","emoji":"✅","id":"status-completed","label":"완료"},{"backgroundColor":"#fff1db","dotColor":"#bb8732","emoji":"⏸️","id":"status-paused","label":"보류"}],"visible":true,"width":105}],"theme":"mint"}');


--
-- Name: site_events_cursor_seq; Type: SEQUENCE SET; Schema: graeboard; Owner: -
--

SELECT pg_catalog.setval('graeboard.site_events_cursor_seq', 6, true);


--
-- Name: sync_outbox_local_seq_seq; Type: SEQUENCE SET; Schema: graeboard; Owner: -
--

SELECT pg_catalog.setval('graeboard.sync_outbox_local_seq_seq', 5, true);


--
-- Name: connection_probes connection_probes_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.connection_probes
    ADD CONSTRAINT connection_probes_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: site_audit site_audit_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_audit
    ADD CONSTRAINT site_audit_pkey PRIMARY KEY (id);


--
-- Name: site_entities site_entities_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_entities
    ADD CONSTRAINT site_entities_pkey PRIMARY KEY (team_id, entity, entity_key);


--
-- Name: site_entity_revisions site_entity_revisions_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_entity_revisions
    ADD CONSTRAINT site_entity_revisions_pkey PRIMARY KEY (team_id, entity, entity_key);


--
-- Name: site_events site_events_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_events
    ADD CONSTRAINT site_events_pkey PRIMARY KEY (cursor);


--
-- Name: site_maintenance_jobs site_maintenance_jobs_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_maintenance_jobs
    ADD CONSTRAINT site_maintenance_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: site_operations site_operations_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_operations
    ADD CONSTRAINT site_operations_pkey PRIMARY KEY (team_id, op_id);


--
-- Name: site_retention site_retention_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_retention
    ADD CONSTRAINT site_retention_pkey PRIMARY KEY (team_id, site_id, kind, entity_key, generation);


--
-- Name: sync_conflicts sync_conflicts_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_conflicts
    ADD CONSTRAINT sync_conflicts_pkey PRIMARY KEY (team_id, conflict_id);


--
-- Name: sync_entities sync_entities_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_entities
    ADD CONSTRAINT sync_entities_pkey PRIMARY KEY (team_id, entity, entity_key);


--
-- Name: sync_objects sync_objects_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_objects
    ADD CONSTRAINT sync_objects_pkey PRIMARY KEY (team_id, hash);


--
-- Name: sync_outbox sync_outbox_op_id_key; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_outbox
    ADD CONSTRAINT sync_outbox_op_id_key UNIQUE (op_id);


--
-- Name: sync_outbox sync_outbox_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_outbox
    ADD CONSTRAINT sync_outbox_pkey PRIMARY KEY (local_seq);


--
-- Name: sync_person_refs sync_person_refs_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_person_refs
    ADD CONSTRAINT sync_person_refs_pkey PRIMARY KEY (team_id, person_id);


--
-- Name: sync_receipts sync_receipts_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_receipts
    ADD CONSTRAINT sync_receipts_pkey PRIMARY KEY (team_id, op_id);


--
-- Name: team_meta team_meta_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.team_meta
    ADD CONSTRAINT team_meta_pkey PRIMARY KEY (singleton);


--
-- Name: team_meta team_meta_team_id_key; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.team_meta
    ADD CONSTRAINT team_meta_team_id_key UNIQUE (team_id);


--
-- Name: team_sync_links team_sync_links_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.team_sync_links
    ADD CONSTRAINT team_sync_links_pkey PRIMARY KEY (team_id);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: site_audit_team_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE INDEX site_audit_team_idx ON graeboard.site_audit USING btree (team_id, created_at);


--
-- Name: site_events_team_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE INDEX site_events_team_idx ON graeboard.site_events USING btree (team_id, cursor);


--
-- Name: site_maintenance_active_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE UNIQUE INDEX site_maintenance_active_idx ON graeboard.site_maintenance_jobs USING btree (team_id) WHERE (phase <> ALL (ARRAY['complete'::text, 'cancelled'::text]));


--
-- Name: sync_outbox_pending_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE INDEX sync_outbox_pending_idx ON graeboard.sync_outbox USING btree (team_id, local_seq) WHERE (status <> 'acknowledged'::text);


--
-- Name: sync_outbox_team_sequence; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE INDEX sync_outbox_team_sequence ON graeboard.sync_outbox USING btree (team_id, local_seq);


--
-- Name: site_audit site_audit_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_audit
    ADD CONSTRAINT site_audit_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_entities site_entities_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_entities
    ADD CONSTRAINT site_entities_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_entity_revisions site_entity_revisions_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_entity_revisions
    ADD CONSTRAINT site_entity_revisions_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_events site_events_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_events
    ADD CONSTRAINT site_events_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_maintenance_jobs site_maintenance_jobs_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_maintenance_jobs
    ADD CONSTRAINT site_maintenance_jobs_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_operations site_operations_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_operations
    ADD CONSTRAINT site_operations_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: site_retention site_retention_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.site_retention
    ADD CONSTRAINT site_retention_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_conflicts sync_conflicts_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_conflicts
    ADD CONSTRAINT sync_conflicts_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_entities sync_entities_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_entities
    ADD CONSTRAINT sync_entities_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_objects sync_objects_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_objects
    ADD CONSTRAINT sync_objects_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_outbox sync_outbox_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_outbox
    ADD CONSTRAINT sync_outbox_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_person_refs sync_person_refs_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_person_refs
    ADD CONSTRAINT sync_person_refs_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: sync_receipts sync_receipts_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.sync_receipts
    ADD CONSTRAINT sync_receipts_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: team_meta team_meta_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.team_meta
    ADD CONSTRAINT team_meta_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: team_sync_links team_sync_links_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.team_sync_links
    ADD CONSTRAINT team_sync_links_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- PostgreSQL database dump complete
--
