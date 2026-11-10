# The Phase 7 DB suite is a standalone script run by tests/phase7/run.sh
# (it needs a disposable local Postgres). Keep plain `pytest` from importing it.
collect_ignore = ["test_phase7_db.py"]
