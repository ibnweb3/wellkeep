//! Vault: the account that physically holds one water point's repair money (a NEP-141 stablecoin).
//!
//! The pool creates it as the sub-account `pump-N.<pool>` with this code and NO access keys, so nobody
//! can sign for it. Its only power is `pay`, and `pay` works only when the pool calls it: the pool
//! decides when (a village vote passed), the vault just sends the tokens.
//!
//! Written straight against the NEAR host functions (no SDK) so the account stays a few KB. The input
//! is only ever produced by the pool, so the tiny JSON reader below is not a general parser.

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn on_panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const IN: u64 = 0; // register holding the call input
const PRED: u64 = 1; // register holding the caller
const STORE: u64 = 2; // register for storage reads

static mut INPUT: [u8; 768] = [0; 768];
static mut STATE: [u8; 256] = [0; 256]; // [pool_len][pool bytes][token bytes]
static mut CALLER: [u8; 128] = [0; 128];
static mut OUT: [u8; 768] = [0; 768];

const KEY: &[u8] = b"s";
const FT_TRANSFER: &[u8] = b"ft_transfer";
const ONE_YOCTO: [u8; 16] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const TGAS_20: u64 = 20_000_000_000_000;

fn fail(msg: &str) -> ! {
    unsafe { near_sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn read_input() -> &'static [u8] {
    unsafe {
        near_sys::input(IN);
        let n = near_sys::register_len(IN) as usize;
        if n > 768 {
            fail("input too long");
        }
        let p = addr_of_mut!(INPUT) as *mut u8;
        near_sys::read_register(IN, p as u64);
        core::slice::from_raw_parts(p, n)
    }
}

/// The text between `"name":"` and the next quote.
fn field<'a>(input: &'a [u8], name: &[u8]) -> &'a [u8] {
    let mut pat = [0u8; 16];
    let l = name.len();
    pat[0] = b'"';
    pat[1..1 + l].copy_from_slice(name);
    pat[1 + l] = b'"';
    pat[2 + l] = b':';
    pat[3 + l] = b'"';
    let pat = &pat[..4 + l];
    let mut i = 0;
    while i + pat.len() <= input.len() {
        if &input[i..i + pat.len()] == pat {
            let start = i + pat.len();
            let mut j = start;
            while j < input.len() && input[j] != b'"' {
                j += 1;
            }
            return &input[start..j];
        }
        i += 1;
    }
    fail("missing field")
}

fn caller() -> &'static [u8] {
    unsafe {
        near_sys::predecessor_account_id(PRED);
        let n = near_sys::register_len(PRED) as usize;
        let p = addr_of_mut!(CALLER) as *mut u8;
        near_sys::read_register(PRED, p as u64);
        core::slice::from_raw_parts(p, n)
    }
}

/// (pool, token) from storage.
fn stored() -> (&'static [u8], &'static [u8]) {
    unsafe {
        if near_sys::storage_read(KEY.len() as u64, KEY.as_ptr() as u64, STORE) == 0 {
            fail("vault is not set up");
        }
        let n = near_sys::register_len(STORE) as usize;
        let p = addr_of_mut!(STATE) as *mut u8;
        near_sys::read_register(STORE, p as u64);
        let s = core::slice::from_raw_parts(p, n);
        let pl = s[0] as usize;
        (&s[1..1 + pl], &s[1 + pl..])
    }
}

/// Called once by the pool in the same transaction that creates the account.
#[no_mangle]
pub extern "C" fn new() {
    unsafe {
        if near_sys::storage_has_key(KEY.len() as u64, KEY.as_ptr() as u64) == 1 {
            fail("already set up");
        }
    }
    let input = read_input();
    let pool = field(input, b"pool");
    let token = field(input, b"token");
    if caller() != pool {
        fail("only the pool can set up its vault");
    }
    if pool.len() > 64 || token.len() > 64 {
        fail("account id too long");
    }
    let mut buf = [0u8; 160];
    buf[0] = pool.len() as u8;
    buf[1..1 + pool.len()].copy_from_slice(pool);
    buf[1 + pool.len()..1 + pool.len() + token.len()].copy_from_slice(token);
    let n = 1 + pool.len() + token.len();
    unsafe {
        near_sys::storage_write(KEY.len() as u64, KEY.as_ptr() as u64, n as u64, buf.as_ptr() as u64, STORE);
    }
}

/// `{"to":"<account>","amount":"<digits>"}`. Sends the stablecoin; only the parent pool may call it.
#[no_mangle]
pub extern "C" fn pay() {
    let (pool, token) = stored();
    if caller() != pool {
        fail("only the pool can make this vault pay");
    }
    let input = read_input();
    let to = field(input, b"to");
    let amount = field(input, b"amount");
    if amount.is_empty() || amount == b"0" {
        fail("nothing to pay");
    }
    // {"receiver_id":"<to>","amount":"<amount>"}
    let out = unsafe { &mut *addr_of_mut!(OUT) };
    let mut n = 0;
    for part in [&b"{\"receiver_id\":\""[..], to, &b"\",\"amount\":\""[..], amount, &b"\"}"[..]] {
        out[n..n + part.len()].copy_from_slice(part);
        n += part.len();
    }
    unsafe {
        let p = near_sys::promise_batch_create(token.len() as u64, token.as_ptr() as u64);
        near_sys::promise_batch_action_function_call(
            p,
            FT_TRANSFER.len() as u64,
            FT_TRANSFER.as_ptr() as u64,
            n as u64,
            out.as_ptr() as u64,
            ONE_YOCTO.as_ptr() as u64,
            TGAS_20,
        );
        near_sys::promise_return(p);
    }
}

/// `{"pool":"...","token":"..."}`
#[no_mangle]
pub extern "C" fn get_info() {
    let (pool, token) = stored();
    let out = unsafe { &mut *addr_of_mut!(OUT) };
    let mut n = 0;
    for part in [&b"{\"pool\":\""[..], pool, &b"\",\"token\":\""[..], token, &b"\"}"[..]] {
        out[n..n + part.len()].copy_from_slice(part);
        n += part.len();
    }
    unsafe { near_sys::value_return(n as u64, out.as_ptr() as u64) }
}
