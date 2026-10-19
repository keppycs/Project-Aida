"""Shared master-tag rules for local Studio and the encode pipeline."""

from __future__ import annotations

from copy import deepcopy
import re
import unicodedata
from uuid import uuid4


TAG_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def normalize_tag(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value)).lower().strip()
    value = re.sub(r"[.'\u2018\u2019]", "", value)
    value = re.sub(r"[-_\u2010-\u2015:,;/\\!?()\[\]{}]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def legacy_tag_id(name: str) -> str:
    value = 14695981039346656037
    for byte in normalize_tag(name).encode("utf-8"):
        value = ((value ^ byte) * 1099511628211) & ((1 << 64) - 1)
    return f"legacy-{value:016x}"


def normalize_registry(source=None) -> dict:
    if source is None:
        source = {"version": 1, "tags": [], "redirects": {}}
    if (not isinstance(source, dict) or source.get("version") != 1
            or not isinstance(source.get("tags"), list) or len(source["tags"]) > 10000
            or not isinstance(source.get("redirects", {}), dict)):
        raise ValueError("The saved tag list is invalid.")
    tags, ids, terms = [], set(), {}
    for item in source["tags"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not TAG_ID.fullmatch(item["id"]) or item["id"] in ids:
            raise ValueError("Each master tag needs a unique valid ID.")
        name, aliases = item.get("name"), item.get("aliases", [])
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100 or CONTROL.search(name) or not normalize_tag(name):
            raise ValueError("Use a tag name of at most 100 characters.")
        if not isinstance(aliases, list) or len(aliases) > 50:
            raise ValueError("Use at most 50 aliases per tag.")
        unique, seen = [], {normalize_tag(name)}
        for alias in aliases:
            if not isinstance(alias, str) or not alias.strip() or len(alias.strip()) > 100 or CONTROL.search(alias) or not normalize_tag(alias):
                raise ValueError("Use aliases of at most 100 characters.")
            key = normalize_tag(alias)
            if key not in seen:
                unique.append(alias.strip())
                seen.add(key)
        for term in seen:
            if term in terms:
                raise ValueError("That tag name or alias is already used by another master tag.")
            terms[term] = item["id"]
        ids.add(item["id"])
        tags.append({"id": item["id"], "name": name.strip(), "aliases": unique})
    redirects = dict(source.get("redirects", {}))
    if len(redirects) > 10000:
        raise ValueError("The tag merge history is too large.")
    for key, value in redirects.items():
        if not isinstance(key, str) or not TAG_ID.fullmatch(key) or not isinstance(value, str) or not TAG_ID.fullmatch(value) or key in ids:
            raise ValueError("The tag merge history is invalid.")
        visited, target = {key}, value
        while target in redirects:
            if target in visited:
                raise ValueError("The tag merge history contains a cycle.")
            visited.add(target)
            target = redirects[target]
        if target not in ids:
            raise ValueError("The tag merge destination is missing.")
        redirects[key] = target
    return {"version": 1, "tags": tags, "redirects": redirects}


def registry_from_videos(videos: list[dict], source=None) -> dict:
    registry = normalize_registry(source)
    ids = {item["id"] for item in registry["tags"]}
    terms = {normalize_tag(term) for item in registry["tags"] for term in (item["name"], *item["aliases"])}
    for video in videos:
        definitions = video.get("tagDefinitions", [])
        if isinstance(definitions, list):
            for definition in definitions:
                if isinstance(definition, dict) and definition.get("id") not in ids and definition.get("id") not in registry["redirects"]:
                    # Embedded definitions permit an encoded package to retain
                    # its chosen names when opened on another computer.
                    try:
                        candidate = normalize_registry({"version": 1, "tags": [definition], "redirects": {}})["tags"][0]
                    except ValueError:
                        continue
                    if any(normalize_tag(term) in terms for term in (candidate["name"], *candidate["aliases"])):
                        continue
                    registry["tags"].append(candidate)
                    ids.add(candidate["id"])
                    terms.update(normalize_tag(term) for term in (candidate["name"], *candidate["aliases"]))
        selected = video.get("tagIds") if "tagIds" in video else None
        names = video.get("tags", [])
        for name in names if isinstance(names, list) else []:
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100 or CONTROL.search(name):
                continue
            key = normalize_tag(name)
            identity = legacy_tag_id(name)
            if selected is not None and identity not in selected:
                continue
            if key and key not in terms and identity not in ids and identity not in registry["redirects"]:
                registry["tags"].append({"id": identity, "name": name.strip(), "aliases": []})
                ids.add(identity)
                terms.add(key)
    return normalize_registry(registry)


def resolve_video_tags(video: dict, registry: dict) -> list[dict]:
    registry = registry_from_videos([video], registry)
    by_id = {tag["id"]: tag for tag in registry["tags"]}
    by_name = {normalize_tag(term): tag for tag in registry["tags"] for term in (tag["name"], *tag["aliases"])}
    output, seen = [], set()
    for value in video.get("tagIds", []) if "tagIds" in video else video.get("tags", []):
        if "tagIds" in video:
            tag = by_id.get(registry["redirects"].get(value, value))
        else:
            # Names may be reused after a rename or merge; retain the original
            # legacy identity before considering a different tag's label.
            legacy = legacy_tag_id(value)
            tag = by_id.get(registry["redirects"].get(legacy, legacy)) or by_name.get(normalize_tag(value))
        if tag is not None and tag["id"] not in seen:
            output.append(deepcopy(tag))
            seen.add(tag["id"])
    return output


def hydrate_video_tags(video: dict, registry: dict) -> dict:
    definitions = resolve_video_tags(video, registry)
    return {**video, "tags": [tag["name"] for tag in definitions],
            "tagIds": [tag["id"] for tag in definitions], "tagDefinitions": definitions}


def update_registry(source: dict, *, tag=None, merge=None) -> dict:
    registry = normalize_registry(source)
    if (tag is None) == (merge is None):
        raise ValueError("Choose one tag update or merge.")
    if tag is not None:
        if not isinstance(tag, dict) or set(tag) - {"id", "name", "aliases"}:
            raise ValueError("Invalid master tag fields.")
        identity = tag.get("id") or f"tag-{uuid4().hex}"
        if identity in registry["redirects"]:
            raise ValueError("That tag was merged. Edit its destination instead.")
        previous = next((item for item in registry["tags"] if item["id"] == identity), None)
        if not isinstance(tag.get("aliases", []), list):
            raise ValueError("Use a list of aliases.")
        if tag.get("id") and previous is None and not any(isinstance(value, str) and identity == legacy_tag_id(value) for value in [tag.get("name", ""), *tag.get("aliases", [])]):
            raise ValueError("That master tag no longer exists. Reload the tag list.")
        aliases = list(tag.get("aliases", []))
        if previous is not None and normalize_tag(previous["name"]) != normalize_tag(tag.get("name", "")):
            aliases.append(previous["name"])
        changed = {"id": identity, "name": tag.get("name"), "aliases": aliases}
        registry["tags"] = [changed if item["id"] == identity else item for item in registry["tags"]]
        if previous is None:
            registry["tags"].append(changed)
    else:
        if not isinstance(merge, dict) or set(merge) != {"source", "target"} or merge["source"] == merge["target"]:
            raise ValueError("Choose two different master tags to merge.")
        by_id = {item["id"]: item for item in registry["tags"]}
        source_tag, target = by_id.get(merge["source"]), by_id.get(merge["target"])
        if source_tag is None or target is None:
            raise ValueError("Choose existing master tags to merge.")
        target["aliases"] = [*target["aliases"], source_tag["name"], *source_tag["aliases"]]
        registry["tags"] = [item for item in registry["tags"] if item["id"] != source_tag["id"]]
        registry["redirects"][source_tag["id"]] = target["id"]
        registry["redirects"] = {key: target["id"] if value == source_tag["id"] else value for key, value in registry["redirects"].items()}
    return normalize_registry(registry)
