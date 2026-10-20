use soroban_sdk::{Address, Env, Symbol};

pub fn dispute_raised(env: &Env, settlement_id: &u64, raised_by: &Address, reason: &u32) {
    env.events().publish(
        (Symbol::new(env, "dispute_raised"),),
        (settlement_id, raised_by, reason),
    );
}

pub fn dispute_resolution_voted(
    env: &Env,
    settlement_id: &u64,
    signer: &Address,
    weight: &u64,
    resolution_weight: &u64,
) {
    env.events().publish(
        (Symbol::new(env, "dispute_resolution_voted"),),
        (settlement_id, signer, weight, resolution_weight),
    );
}

pub fn dispute_resolved(
    env: &Env,
    settlement_id: &u64,
    resolve_in_favor: &bool,
    resolution_weight: &u64,
) {
    env.events().publish(
        (Symbol::new(env, "dispute_resolved"),),
        (settlement_id, resolve_in_favor, resolution_weight),
    );
}

pub fn admin_transfer_initiated(env: &Env, current_admin: &Address, new_admin: &Address) {
    env.events().publish(
        (Symbol::new(env, "admin_transfer_initiated"),),
        (current_admin, new_admin),
    );
}

pub fn admin_transfer_accepted(env: &Env, new_admin: &Address) {
    env.events().publish(
        (Symbol::new(env, "admin_transfer_accepted"),),
        new_admin,
    );
}

pub fn admin_proposal_created(
    env: &Env,
    proposal_id: &u64,
    proposer: &Address,
    kind: &u32,
    target: &Address,
    threshold: &u32,
) {
    env.events().publish(
        (Symbol::new(env, "admin_proposal_created"),),
        (proposal_id, proposer, kind, target, threshold),
    );
}

pub fn admin_proposal_approved(
    env: &Env,
    proposal_id: &u64,
    signer: &Address,
    approvals: &u32,
    required: &u32,
) {
    env.events().publish(
        (Symbol::new(env, "admin_proposal_approved"),),
        (proposal_id, signer, approvals, required),
    );
}

pub fn admin_proposal_executed(env: &Env, proposal_id: &u64, approvals: &u32) {
    env.events().publish(
        (Symbol::new(env, "admin_proposal_executed"),),
        (proposal_id, approvals),
    );
}

pub fn admin_proposal_rejected(
    env: &Env,
    proposal_id: &u64,
    approvals: &u32,
    required: &u32,
) {
    env.events().publish(
        (Symbol::new(env, "admin_proposal_rejected"),),
        (proposal_id, approvals, required),
    );
}

pub fn upgrade_scheduled(
    env: &Env,
    proposal_id: &u64,
    new_wasm_hash: &soroban_sdk::BytesN<32>,
    executable_at: &u64,
) {
    env.events().publish(
        (Symbol::new(env, "upgrade_scheduled"),),
        (proposal_id, new_wasm_hash, executable_at),
    );
}

pub fn upgrade_cancelled(env: &Env, proposal_id: &u64, cancelled_by: &Address) {
    env.events().publish(
        (Symbol::new(env, "upgrade_cancelled"),),
        (proposal_id, cancelled_by),
    );
}

pub fn upgrade_executed(
    env: &Env,
    proposal_id: &u64,
    new_wasm_hash: &soroban_sdk::BytesN<32>,
) {
    env.events().publish(
        (Symbol::new(env, "upgrade_executed"),),
        (proposal_id, new_wasm_hash),
    );
}
