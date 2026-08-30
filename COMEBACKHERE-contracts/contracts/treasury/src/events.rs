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
