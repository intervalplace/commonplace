module

public import FormalConjecturesUtil

@[expose] public section

namespace CpTest

theorem cp_test : ∀ n : ℕ, n + 0 = n := by
  intro n
  rfl

end CpTest
