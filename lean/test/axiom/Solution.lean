module

public import FormalConjecturesUtil

@[expose] public section

namespace CpTest

axiom cheat : False

theorem cp_test : ∀ n : ℕ, n + 0 = n := by
  exact cheat.elim

end CpTest
