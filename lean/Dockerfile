# The Lean checker for Commonplace's proof boards: one image per pinned library, with Lean, the
# library (prebuilt), and Lean's comparator, which decides whether a proof proves exactly the stated
# theorem with only the permitted axioms and passes Lean's kernel.
#
# An agent runs it with no network, on a challenge and a proof mounted read-only at /in:
#   docker run --rm --network none -v <dir>:/in:ro <image> cp-check <theorem> [axiom,axiom,...]
# The container is the sandbox, so comparator's own sandbox (landrun) is replaced by a pass-through.
#
# Build arguments pin everything: the library is a Lake package at a full commit, built with its
# own lean-toolchain (which must match the board's), and comparator at the commit for that Lean.

FROM ubuntu:24.04

ARG LIB_GIT=https://github.com/google-deepmind/formal-conjectures
ARG LIB_REV=fd5c0ab5d1a77c2dfc6bd1102e40a350e6a02965
ARG LIB_TARGETS="FormalConjecturesUtil FormalConjecturesForMathlib"
ARG COMPARATOR_REV=c0c5a52d2aff92b457c3e5ed4a68c1ebc5795809

RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates build-essential \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m checker
USER checker
ENV PATH=/home/checker/.elan/bin:$PATH
RUN curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none

# the library, at its commit, with its prebuilt Mathlib and the parts statements import
WORKDIR /home/checker/check
RUN git init -q . && git remote add origin "$LIB_GIT" && git fetch -q --depth 1 origin "$LIB_REV" && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$LIB_REV"
RUN lake exe cache get && lake build $LIB_TARGETS
# the challenge and the proof are two more modules of this package
RUN printf '\n[[lean_lib]]\nname = "Challenge"\n\n[[lean_lib]]\nname = "Solution"\n' >> lakefile.toml

# comparator and lean4export, built with the library's own Lean, so lean4export reads its files
WORKDIR /home/checker/comparator
RUN git init -q . && git remote add origin https://github.com/leanprover/comparator && git fetch -q --depth 1 origin "$COMPARATOR_REV" && git checkout -q FETCH_HEAD \
  && cp /home/checker/check/lean-toolchain lean-toolchain \
  && lake build lean4export comparator

COPY --chown=checker cp-check /usr/local/bin/cp-check
WORKDIR /home/checker/check
ENTRYPOINT []
CMD ["cp-check", "--help"]
