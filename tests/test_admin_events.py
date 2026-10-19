"""Job recovery without a server, user configuration, credentials or media."""
from pathlib import Path
import queue
import sys
import unittest

sys.path.insert(0, str(Path(__file__).absolute().parents[1] / "src"))
from admin_events import JobEvents


class JobEventsTests(unittest.TestCase):
    def test_tabs_receive_independent_live_events_and_current_snapshots(self):
        feed = JobEvents()
        first, second = feed.subscribe(), feed.subscribe()
        self.assertEqual(first.get_nowait(), {"type": "job_snapshot", "events": []})
        second.get_nowait()
        start = {"type": "encode_start"}
        progress = {"type": "progress", "channel": "encode", "stage": "AV1", "current": 37, "total": 100}
        feed.publish(start)
        feed.publish(progress)
        for client in (first, second):
            self.assertEqual(client.get_nowait(), start)
            self.assertEqual(client.get_nowait(), progress)
        self.assertEqual(feed.subscribe().get_nowait()["events"], [start, progress])
        feed.unsubscribe(first)
        feed.publish({"type": "encode_done", "ok": False})
        self.assertTrue(first.empty())
        self.assertEqual(second.get_nowait()["type"], "encode_done")

    def test_snapshots_keep_latest_stages_bounded_logs_and_result(self):
        feed = JobEvents()
        feed.publish({"type": "maint_start", "job": "sync"})
        for current in range(600):
            feed.publish({"type": "progress", "channel": "maint", "phase": "scan", "current": current, "total": 600})
            feed.publish({"type": "log", "channel": "maint", "message": str(current)})
        feed.publish({"type": "sync_result", "summary": "Fixture result"})
        feed.publish({"type": "maint_done", "ok": True})
        events = feed.subscribe().get_nowait()["events"]
        self.assertEqual(len(events), 204)
        self.assertEqual(events[1]["current"], 599)
        self.assertEqual(events[2]["message"], "400")
        self.assertEqual(events[-1]["type"], "maint_done")
        feed.publish({"type": "encode_start"})
        self.assertEqual(len(feed.subscribe().get_nowait()["events"]), 205)
        feed.publish({"type": "maint_start", "job": "dedupe"})
        self.assertEqual([event["type"] for event in feed.subscribe().get_nowait()["events"]], ["encode_start", "maint_start"])

    def test_slow_tab_catches_up_without_unbounded_backlog(self):
        feed = JobEvents()
        client = feed.subscribe()
        feed.publish({"type": "encode_start"})
        for current in range(1200):
            feed.publish({"type": "progress", "channel": "encode", "stage": "AV1", "current": current, "total": 1200})
        self.assertLessEqual(client.qsize(), 512)
        received = []
        while not client.empty():
            event = client.get_nowait()
            received.extend(event["events"] if event["type"] == "job_snapshot" else [event])
        self.assertEqual(received[-1]["current"], 1199)
        self.assertTrue(any(event["type"] == "encode_start" for event in received))

    def test_callers_and_tabs_cannot_mutate_each_others_state(self):
        feed = JobEvents()
        client = feed.subscribe()
        client.get_nowait()
        event = {"type": "encode_done", "ok": False, "details": ["Fixture"]}
        feed.publish(event)
        event["details"].clear()
        client.get_nowait()["details"].clear()
        self.assertEqual(feed.subscribe().get_nowait()["events"][0]["details"], ["Fixture"])


if __name__ == "__main__":
    unittest.main()
