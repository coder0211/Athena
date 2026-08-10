"""The shared system-prompt scaffolding — especially the honesty guardrail that
counterbalances the 'always answer fully' completeness bar (no network)."""

from query import personas


def test_system_prompt_has_the_honesty_guardrail():
    prompt = personas.system_prompt("business")
    low = prompt.lower()
    # It must tell the model to admit a miss instead of inventing one.
    assert "never" in low and "fabricate" in low
    assert "did not actually read" in low  # no made-up citations
    assert "isn't in the indexed codebase" in low


def test_honesty_comes_after_completeness_before_diagrams():
    prompt = personas.system_prompt("technical")
    honesty = prompt.find("WHEN THE ANSWER ISN'T IN THE INDEXED CODE")
    completeness = prompt.find("BE COMPLETE")
    diagram = prompt.find("DIAGRAMS")
    assert -1 < completeness < honesty < diagram


def test_every_persona_prompt_includes_the_guardrail():
    for p in personas.list_personas():
        prompt = personas.system_prompt(p["id"])
        assert "never" in prompt.lower() and "fabricate" in prompt.lower()


def test_unknown_persona_falls_back_but_still_guards():
    # An unknown id resolves to the default persona, which still carries the block.
    prompt = personas.system_prompt("does-not-exist")
    assert "fabricate" in prompt.lower()
