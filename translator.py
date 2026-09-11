"""
Translator module for VideoRAG
Converts Hindi transcripts to English before RAG processing.
"""

import os
import re
from dotenv import load_dotenv

load_dotenv()

# Lazy-loaded Gemini translator LLM
_translator_llm = None


def _get_translator_llm():
    global _translator_llm

    if _translator_llm is None:
        from langchain_google_genai import ChatGoogleGenerativeAI

        # langchain_google_genai reads GOOGLE_API_KEY, but many users
        # (including this project's .env) store it as GEMINI_API_KEY.
        # Accept both so translation doesn't crash with "API key not found".
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "Neither GOOGLE_API_KEY nor GEMINI_API_KEY is set; "
                "Hindi transcript will be used untranslated."
            )

        _translator_llm = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0,
            api_key=api_key,
        )

    return _translator_llm


def contains_hindi(text: str) -> bool:
    """Return True if text contains Devanagari characters."""
    if not text:
        return False

    return bool(re.search(r"[\u0900-\u097F]", text))


def translate_hindi_to_english(
    text: str,
    chunk_size: int = 3500
) -> str:
    """
    Translate Hindi or mixed Hindi-English transcript into English
    using Gemini.
    """

    if not text or not text.strip():
        return text

    if not contains_hindi(text):
        return text

    print("Translating Hindi transcript to English...")

    try:
        llm = _get_translator_llm()
    except Exception as e:
        print(f"Translation skipped (no API key / init failed): {e}")
        return text

    chunks = [
        text[i:i + chunk_size]
        for i in range(0, len(text), chunk_size)
    ]

    translated_parts = []

    for chunk in chunks:

        if not contains_hindi(chunk):
            translated_parts.append(chunk)
            continue

        prompt = f"""
Translate the following transcript into English.

Rules:
- Translate ALL Hindi/Devanagari text into natural English.
- Keep existing English text as English.
- Handle mixed Hindi-English text correctly.
- Preserve the original meaning.
- Do not summarize.
- Do not remove information.
- Do not add information.
- Return ONLY the translated transcript.
- Do not include Hindi in the output.

Transcript:
{chunk}
"""

        try:
            result = llm.invoke(prompt)

            content = getattr(result, "content", "")

            if content and content.strip():
                translated_parts.append(content.strip())
            else:
                translated_parts.append(chunk)

        except Exception as e:
            print(f"Translation warning: {e}")
            translated_parts.append(chunk)

    return " ".join(translated_parts)


def translate_if_needed(text: str) -> str:
    """Translate transcript only when Hindi is detected."""

    if contains_hindi(text):
        return translate_hindi_to_english(text)

    return text