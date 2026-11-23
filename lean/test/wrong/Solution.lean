module

public import FormalConjecturesUtil

@[expose] public section

namespace CpTest

-- a different (true) statement under the same name: must be refused
theorem cp_test : ∀ n : ℕ, n + 0 = n + 0 := by
  intro n
  rfl

end CpTest
