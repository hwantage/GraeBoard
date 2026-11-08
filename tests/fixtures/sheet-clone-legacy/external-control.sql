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
-- Name: access_identities; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.access_identities (
    issuer text NOT NULL,
    subject text NOT NULL,
    user_id text NOT NULL
);


--
-- Name: access_tokens; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.access_tokens (
    id text NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    prefix text NOT NULL,
    created_at text NOT NULL,
    token_ciphertext text NOT NULL,
    CONSTRAINT access_tokens_name_check CHECK (((length(name) >= 1) AND (length(name) <= 80))),
    CONSTRAINT access_tokens_token_hash_check CHECK ((length(token_hash) = 64))
);


--
-- Name: connection_probes; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.connection_probes (
    id text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: control_audit; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.control_audit (
    id text NOT NULL,
    actor_id text,
    action text NOT NULL,
    target text NOT NULL,
    payload text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: control_jobs; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.control_jobs (
    id text NOT NULL,
    team_id text,
    kind text NOT NULL,
    phase text NOT NULL,
    payload text NOT NULL,
    created_at text NOT NULL
);


--
-- Name: control_meta; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.control_meta (
    singleton integer NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    setup_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT control_meta_singleton_check CHECK ((singleton = 1))
);


--
-- Name: control_preferences; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.control_preferences (
    user_id text NOT NULL,
    payload text NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.memberships (
    user_id text NOT NULL,
    team_id text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    CONSTRAINT memberships_role_check CHECK ((role = ANY (ARRAY['lead'::text, 'member'::text, 'viewer'::text])))
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
-- Name: teams; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.teams (
    id text NOT NULL,
    name text NOT NULL,
    profile_id text,
    status text DEFAULT 'unconnected'::text NOT NULL,
    config_revision bigint DEFAULT 0 NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: graeboard; Owner: -
--

CREATE TABLE graeboard.users (
    id text NOT NULL,
    username text NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    system_role text DEFAULT 'user'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    color text DEFAULT '#177b70'::text NOT NULL,
    avatar_initials text DEFAULT ''::text NOT NULL,
    avatar_image text DEFAULT ''::text NOT NULL,
    created_at text NOT NULL,
    CONSTRAINT users_system_role_check CHECK ((system_role = ANY (ARRAY['admin'::text, 'user'::text])))
);


--
-- Data for Name: access_identities; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.access_identities VALUES ('https://fixture.cloudflareaccess.com', 'external-subject', '897806d1-39e9-4732-a768-e5f8ac7f7631');


--
-- Data for Name: access_tokens; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: connection_probes; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: control_audit; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: control_jobs; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: control_meta; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.control_meta VALUES (1, 4, true);


--
-- Data for Name: control_preferences; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: memberships; Type: TABLE DATA; Schema: graeboard; Owner: -
--



--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.schema_migrations VALUES ('control', 1, '4fd51af986baa021025c0be7a8bccbabfb57e6f756db81826aa53e5acaccf52a', '2026-11-07T16:37:15.170Z');
INSERT INTO graeboard.schema_migrations VALUES ('control', 2, '93267cbac2c6ec29df185703716f1a557241b9a9309790ecd0a17e3436478bb1', '2026-11-07T16:37:15.172Z');


--
-- Data for Name: teams; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.teams VALUES ('377e8e56-aea7-46ea-a51e-0715b9b79ca3', '사본 전환 fixture', 'outside', 'active', 0);


--
-- Data for Name: users; Type: TABLE DATA; Schema: graeboard; Owner: -
--

INSERT INTO graeboard.users VALUES ('897806d1-39e9-4732-a768-e5f8ac7f7631', 'outside@example.com', 'outside@example.com', '외부 관리자', 'admin', true, '#177b70', '', '', '2026-11-07T16:37:17.230Z');


--
-- Name: access_identities access_identities_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_identities
    ADD CONSTRAINT access_identities_pkey PRIMARY KEY (issuer, subject);


--
-- Name: access_identities access_identities_user_id_key; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_identities
    ADD CONSTRAINT access_identities_user_id_key UNIQUE (user_id);


--
-- Name: access_tokens access_tokens_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_tokens
    ADD CONSTRAINT access_tokens_pkey PRIMARY KEY (id);


--
-- Name: access_tokens access_tokens_token_hash_key; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_tokens
    ADD CONSTRAINT access_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: connection_probes connection_probes_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.connection_probes
    ADD CONSTRAINT connection_probes_pkey PRIMARY KEY (id);


--
-- Name: control_audit control_audit_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_audit
    ADD CONSTRAINT control_audit_pkey PRIMARY KEY (id);


--
-- Name: control_jobs control_jobs_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_jobs
    ADD CONSTRAINT control_jobs_pkey PRIMARY KEY (id);


--
-- Name: control_meta control_meta_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_meta
    ADD CONSTRAINT control_meta_pkey PRIMARY KEY (singleton);


--
-- Name: control_preferences control_preferences_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_preferences
    ADD CONSTRAINT control_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (user_id, team_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: access_tokens_user_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE INDEX access_tokens_user_idx ON graeboard.access_tokens USING btree (user_id, created_at);


--
-- Name: control_jobs_active_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE UNIQUE INDEX control_jobs_active_idx ON graeboard.control_jobs USING btree (team_id) WHERE (phase <> ALL (ARRAY['complete'::text, 'cancelled'::text]));


--
-- Name: users_email_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE UNIQUE INDEX users_email_idx ON graeboard.users USING btree (lower(email));


--
-- Name: users_username_idx; Type: INDEX; Schema: graeboard; Owner: -
--

CREATE UNIQUE INDEX users_username_idx ON graeboard.users USING btree (lower(username));


--
-- Name: access_identities access_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_identities
    ADD CONSTRAINT access_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES graeboard.users(id);


--
-- Name: access_tokens access_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.access_tokens
    ADD CONSTRAINT access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES graeboard.users(id) ON DELETE CASCADE;


--
-- Name: control_audit control_audit_actor_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_audit
    ADD CONSTRAINT control_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES graeboard.users(id);


--
-- Name: control_jobs control_jobs_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_jobs
    ADD CONSTRAINT control_jobs_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id);


--
-- Name: control_preferences control_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.control_preferences
    ADD CONSTRAINT control_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES graeboard.users(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_team_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.memberships
    ADD CONSTRAINT memberships_team_id_fkey FOREIGN KEY (team_id) REFERENCES graeboard.teams(id) ON DELETE CASCADE;


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: graeboard; Owner: -
--

ALTER TABLE ONLY graeboard.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES graeboard.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--
