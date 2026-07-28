package extension

// In-memory size caps. Histories are lossy by design: the enclave holds them in
// RAM and never restarts on its own, so unbounded growth is a leak.
// Tests can override these (var, not const).
var (
	MaxUserDepositsHistory  = 200
	MaxUserWithdrawsHistory = 200
)
