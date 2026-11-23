module

public import FormalConjecturesUtil

@[expose] public section

namespace CpTest

/-- A statement the checker's own tests prove: adding zero changes nothing. -/
theorem cp_test : ∀ n : ℕ, n + 0 = n := by
  sorry

end CpTest
