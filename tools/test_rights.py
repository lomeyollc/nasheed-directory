#!/usr/bin/env python3
"""
Tests for the rights gate in the ingest pipeline.

    python3 -m unittest tools/test_rights.py

The database refuses to publish a track without a rights basis (see
migrations/0003_rights_gate.sql). These tests hold the pipeline to the same
rule one step earlier, so a run does not upload audio and build rows only to
have the trigger refuse the whole batch:

  - a licence typed by an archive.org uploader never becomes a rights basis
  - a Public Domain Mark on a recording from after 1950 is dropped at harvest
  - publish.py writes a row only with an explicit rights basis and evidence
  - publish.py skips anything on the blocklist
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import harvest  # noqa: E402
import publish  # noqa: E402


def archive_item(**overrides):
    item = {
        "identifier": "some-item",
        "title": "A Naat",
        "creator": "Some Singer",
        "licenseurl": "http://creativecommons.org/licenses/by/3.0/",
        "uploader": "someone@example.com",
        "date": "2013-09-01",
        "subject": ["naat"],
    }
    item.update(overrides)
    return item


class HarvestLicenceRules(unittest.TestCase):
    def test_uploader_licence_never_sets_a_rights_basis(self):
        candidate = harvest.archive_candidate(archive_item(), "naat")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["license"], "CC-BY")
        self.assertIsNone(candidate.get("rights_basis"))

    def test_keeps_the_uploader_and_date_for_the_rights_check(self):
        candidate = harvest.archive_candidate(archive_item(), "naat")
        self.assertEqual(candidate["uploader"], "someone@example.com")
        self.assertEqual(candidate["date"], "2013-09-01")

    def test_refuses_a_public_domain_mark_on_a_modern_recording(self):
        # The exact shape of 104 of the 110 tracks taken offline on 2026-11-25.
        item = archive_item(licenseurl="http://creativecommons.org/publicdomain/mark/1.0/", date="2018-01-15")
        self.assertIsNone(harvest.archive_candidate(item, "naat"))

    def test_refuses_a_public_domain_mark_with_no_date(self):
        # Without a date nobody can check the mark, so it is not evidence.
        item = archive_item(licenseurl="http://creativecommons.org/publicdomain/mark/1.0/", date=None)
        self.assertIsNone(harvest.archive_candidate(item, "naat"))

    def test_keeps_a_public_domain_mark_on_an_old_recording(self):
        item = archive_item(licenseurl="http://creativecommons.org/publicdomain/mark/1.0/", date="1931")
        candidate = harvest.archive_candidate(item, "naat")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["license"], "public-domain")
        self.assertIsNone(candidate.get("rights_basis"))

    def test_1950_is_the_last_year_a_mark_is_believed(self):
        self.assertTrue(harvest.pdm_allowed("1950-06-01"))
        self.assertFalse(harvest.pdm_allowed("1951"))
        self.assertFalse(harvest.pdm_allowed("not a date"))

    def test_still_drops_noncommercial_licences(self):
        item = archive_item(licenseurl="http://creativecommons.org/licenses/by-nc-sa/3.0/")
        self.assertIsNone(harvest.archive_candidate(item, "naat"))

    def test_commons_public_domain_is_not_cc0(self):
        # CC0 is a dedication the OWNER makes. A "public domain" tag is a
        # claim about age, and must go through the date rule, not around it.
        self.assertEqual(harvest.normalise_short_name("Public domain"), "public-domain")
        self.assertEqual(harvest.normalise_short_name("CC0"), "CC0")


VALID_RIGHTS = {
    "rights_basis": "artist_upload",
    "rights_evidence_url": "https://archive.org/details/own-upload",
    "rights_checked_by": "maintainer@example.com",
    "rights_checked_at": "2026-11-25T00:00:00+00:00",
}


class PublishRightsRules(unittest.TestCase):
    def test_refuses_a_row_with_only_a_licence(self):
        rights, reason = publish.rights_for({"license": "CC-BY"}, None)
        self.assertIsNone(rights)
        self.assertIn("rights basis", reason)

    def test_refuses_an_unknown_basis(self):
        record = {**VALID_RIGHTS, "rights_basis": "uploader_is_artist"}
        self.assertIsNone(publish.rights_for({"license": "CC-BY"}, record)[0])

    def test_refuses_a_basis_without_evidence(self):
        record = {**VALID_RIGHTS, "rights_evidence_url": None}
        self.assertIsNone(publish.rights_for({"license": "CC-BY"}, record)[0])

    def test_refuses_evidence_that_is_not_a_link(self):
        record = {**VALID_RIGHTS, "rights_evidence_url": "the uploader said so"}
        self.assertIsNone(publish.rights_for({"license": "CC-BY"}, record)[0])

    def test_refuses_public_domain_unless_the_basis_is_age(self):
        self.assertIsNone(publish.rights_for({"license": "public-domain"}, VALID_RIGHTS)[0])

    def test_refuses_age_as_a_basis_for_a_modern_recording(self):
        record = {**VALID_RIGHTS, "rights_basis": "public_domain_by_age"}
        self.assertIsNone(publish.rights_for({"license": "public-domain", "date": "1990"}, record)[0])

    def test_accepts_a_complete_record(self):
        rights, _ = publish.rights_for({"license": "CC-BY"}, VALID_RIGHTS)
        self.assertEqual(rights["rights_basis"], "artist_upload")
        self.assertEqual(rights["rights_evidence_url"], VALID_RIGHTS["rights_evidence_url"])


class PublishBlocklist(unittest.TestCase):
    BLOCKED = [
        ("artist", "blocked singer"),
        ("uploader", "reuploader@example.com"),
        ("source_url", "https://archive.org/details/militant-item"),
    ]

    def test_matches_artist_ignoring_case(self):
        self.assertIsNotNone(publish.blocked_reason({"artist": " BLOCKED SINGER "}, self.BLOCKED))

    def test_matches_uploader(self):
        self.assertIsNotNone(publish.blocked_reason({"uploader": "Reuploader@example.com"}, self.BLOCKED))

    def test_matches_source_url(self):
        row = {"source_url": "https://archive.org/details/militant-item"}
        self.assertIsNotNone(publish.blocked_reason(row, self.BLOCKED))

    def test_lets_an_unrelated_row_through(self):
        row = {"artist": "Abdul Haseeb Khan", "uploader": "x@example.com", "source_url": "https://a.org/b"}
        self.assertIsNone(publish.blocked_reason(row, self.BLOCKED))


if __name__ == "__main__":
    unittest.main()
