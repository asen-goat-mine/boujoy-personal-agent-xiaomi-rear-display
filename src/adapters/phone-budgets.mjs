// One place for how long each kind of phone step may take. The layers used to
// disagree (45 s above, 8–12 s in the driver, 90 s in the Python bridge), so a phone
// that was merely slow had its tap or app start reported as "result unknown".
// Every value stays under the 45 s a tool call gets and the 90 s bridge limit.
export const PHONE_BUDGETS=Object.freeze({
  call:45_000,     // a whole tool call from the broker
  action:20_000,   // tap, long press, typing, key, swipe: wait this long for the receipt
  launch:30_000,   // opening an app (a cold start on a slow phone)
  read:6_000,      // one screen reading
  status:4_000     // status and capability checks
});
