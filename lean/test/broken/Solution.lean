module

public import FormalConjecturesUtil

@[expose] public section

namespace CpTest

-- a proof that doesn't build: the reason must be Lean's own error, line and all
theorem cp_test : ∀ n : ℕ, n + 0 = n := by
  intro n
  exact absurd (by decide : (1 : ℕ) = 2) (by decide)

end CpTest
