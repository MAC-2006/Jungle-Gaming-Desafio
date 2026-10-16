import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade vivem AQUI (no banco),
 * não apenas no código da aplicação.
 */
export class Migration20260101000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid         PRIMARY KEY,
        player_id   uuid         NOT NULL,
        currency    varchar(3)   NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer      NOT NULL DEFAULT 1,
        created_at  timestamptz  NOT NULL,
        updated_at  timestamptz  NOT NULL,
        CONSTRAINT wallets_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wallets_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive_ck CHECK (version >= 1),
        CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency)
      )
    `);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid          PRIMARY KEY,
        provider_id                        varchar(100)  NOT NULL,
        external_transaction_id            varchar(200)  NOT NULL,
        idempotency_key                    varchar(300)  NOT NULL,
        payload_hash                       char(64)      NOT NULL,
        wallet_id                          uuid          NOT NULL REFERENCES wallets(id),
        player_id                          uuid          NOT NULL,
        round_id                           varchar(200)  NOT NULL,
        game_id                            varchar(200)  NOT NULL,
        kind                               varchar(16)   NOT NULL,
        amount                             numeric(19,2) NOT NULL,
        currency                           varchar(3)    NOT NULL,
        reference_external_transaction_id  varchar(200),
        reference_transaction_id           uuid          REFERENCES wager_transactions(id),
        status                             varchar(20)   NOT NULL,
        failure_code                       varchar(64),
        result_balance                     numeric(19,2),
        reference_attempts                 integer       NOT NULL DEFAULT 0,
        next_attempt_at                    timestamptz,
        created_at                         timestamptz   NOT NULL,
        processed_at                       timestamptz,
        CONSTRAINT wager_tx_idempotency_key_uq UNIQUE (idempotency_key),
        CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_kind_ck CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT wager_tx_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT wager_tx_currency_format_ck CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT wager_tx_reversal_requires_ref_ck
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_bet_has_no_ref_ck
          CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_opening_is_internal_ck
          CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        CONSTRAINT wager_tx_failure_code_ck
          CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL),
        CONSTRAINT wager_tx_processed_ck
          CHECK (status <> 'PROCESSED' OR (processed_at IS NOT NULL AND result_balance IS NOT NULL)),
        CONSTRAINT wager_tx_pending_ref_schedule_ck
          CHECK (status <> 'PENDING_REFERENCE' OR next_attempt_at IS NOT NULL)
      )
    `);
    this.addSql(`CREATE INDEX wager_tx_wallet_created_idx ON wager_transactions (wallet_id, created_at)`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due_idx
        ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE'
    `);
    // Uma transação só pode ser revertida UMA vez por uma reversão PROCESSED (rede de segurança do banco).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK') AND reference_transaction_id IS NOT NULL
    `);

    // Estados terminais são imutáveis; transações são auditáveis e nunca apagadas.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions rows are never deleted' USING ERRCODE = '23514';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is already % (terminal state is immutable)', OLD.id, OLD.status
            USING ERRCODE = '23514';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid transition PENDING_REFERENCE -> PENDING' USING ERRCODE = '23514';
        END IF;
        IF NEW.id <> OLD.id OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.provider_id <> OLD.provider_id OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.amount <> OLD.amount OR NEW.kind <> OLD.kind
           OR NEW.player_id <> OLD.player_id OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id
           OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id THEN
          RAISE EXCEPTION 'immutable columns of transaction % cannot change', OLD.id USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $fn$
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()
    `);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq             bigint GENERATED ALWAYS AS IDENTITY,
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL REFERENCES wallets(id),
        transaction_id  uuid          NOT NULL REFERENCES wager_transactions(id),
        direction       varchar(6)    NOT NULL,
        amount          numeric(19,2) NOT NULL,
        currency        varchar(3)    NOT NULL,
        balance_before  numeric(19,2) NOT NULL,
        balance_after   numeric(19,2) NOT NULL,
        created_at      timestamptz   NOT NULL,
        CONSTRAINT ledger_seq_uq UNIQUE (seq),
        CONSTRAINT ledger_one_entry_per_wallet_tx_uq UNIQUE (wallet_id, transaction_id),
        CONSTRAINT ledger_direction_ck CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      )
    `);
    this.addSql(`CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)`);

    // Ledger imutável: nenhum UPDATE/DELETE.
    this.addSql(`
      CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP USING ERRCODE = '23514';
      END $fn$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable()
    `);
    // Cadeia íntegra: balance_before do novo lançamento == balance_after do anterior da mesma wallet.
    this.addSql(`
      CREATE FUNCTION ledger_check_chain() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE prev numeric(19,2);
      BEGIN
        SELECT balance_after INTO prev FROM wallet_ledger_entries
          WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
        IF NOT FOUND THEN prev := 0; END IF;
        IF NEW.balance_before <> prev THEN
          RAISE EXCEPTION 'ledger chain broken for wallet %: balance_before % <> previous balance_after %',
            NEW.wallet_id, NEW.balance_before, prev USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $fn$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_check_chain_trg BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_check_chain()
    `);

    // ------------------------------------------------------------------ wallet <-> ledger
    // Saldo só muda junto com um lançamento (e vice-versa): verificado no COMMIT (deferred).
    this.addSql(`
      CREATE FUNCTION wallet_check_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE last_balance numeric(19,2);
      BEGIN
        SELECT balance_after INTO last_balance FROM wallet_ledger_entries
          WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
        IF NOT FOUND THEN last_balance := 0; END IF;
        IF NEW.balance <> last_balance THEN
          RAISE EXCEPTION 'wallet % balance % does not match last ledger balance_after %',
            NEW.id, NEW.balance, last_balance USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END $fn$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_balance_matches_ledger_trg
        AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION wallet_check_balance_matches_ledger()
    `);
    // version incrementa somente quando o saldo muda; identidade da wallet é imutável.
    this.addSql(`
      CREATE FUNCTION wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets are never deleted' USING ERRCODE = '23514';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = '23514';
        END IF;
        IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
          RAISE EXCEPTION 'wallet version must increase by 1 when balance changes' USING ERRCODE = '23514';
        END IF;
        IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet version must not change when balance is unchanged' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $fn$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_guard_trg BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION wallet_guard()
    `);

    // ------------------------------------------------------------------ inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(100) NOT NULL,
        message_id     varchar(200) NOT NULL,
        payload_hash   char(64)     NOT NULL,
        received_at    timestamptz  NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);
    this.addSql(`
      CREATE TABLE outbox_messages (
        seq              bigint GENERATED ALWAYS AS IDENTITY,
        id               uuid         PRIMARY KEY,
        aggregate_id     uuid         NOT NULL,
        event_type       varchar(100) NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text,
        CONSTRAINT outbox_seq_uq UNIQUE (seq),
        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0)
      )
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (seq) WHERE published_at IS NULL
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_guard()`);
    this.addSql(`DROP FUNCTION IF EXISTS wallet_check_balance_matches_ledger()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_check_chain()`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable()`);
    this.addSql(`DROP FUNCTION IF EXISTS wager_tx_guard()`);
  }
}
