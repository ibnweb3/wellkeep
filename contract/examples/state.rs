//! Prints the contract's initial storage in the JSON shape `near contract state-init` expects
//! (base64 key -> base64 value), using the contract's own Borsh layout, so the keyless account's
//! address is derived from exactly the bytes the contract would have written itself.
//!
//! cargo run --release --features state-tool --example state -- <signerA> <signerB> <root_hex> <households> <hold_s> <window_s> <min_replies> <sample> <max_price> <tier0_cap> <tier1_cap> <first_pct> <rebroken> <attempts> <token>
use borehole_pool::{Contract, Params};
use near_sdk::json_types::{U128, U64};
use near_sdk::borsh;

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for ch in bytes.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if ch.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if ch.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    assert_eq!(a.len(), 15, "see the usage line at the top of this file");
    let params = Params {
        token: a[14].parse().unwrap(),
        hold_ns: U64(a[4].parse::<u64>().unwrap() * 1_000_000_000),
        vote_window_ns: U64(a[5].parse::<u64>().unwrap() * 1_000_000_000),
        min_replies: a[6].parse().unwrap(),
        sample_size: a[7].parse().unwrap(),
        max_price: U128(a[8].parse().unwrap()),
        tier0_cap: U128(a[9].parse().unwrap()),
        tier1_cap: U128(a[10].parse().unwrap()),
        first_pct: a[11].parse().unwrap(),
        rebroken_needed: a[12].parse().unwrap(),
        max_attempts: a[13].parse().unwrap(),
    };
    let c = Contract::build(
        [a[0].parse().unwrap(), a[1].parse().unwrap()],
        params,
        unhex(&a[2]),
        a[3].parse().unwrap(),
    );
    let bytes = borsh::to_vec(&c).unwrap();
    println!("{{\n  \"{}\": \"{}\"\n}}", b64(b"STATE"), b64(&bytes));
}
