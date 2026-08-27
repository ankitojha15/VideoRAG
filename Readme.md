VideoRAG — YouTube Video Chatbot

A RAG-based chatbot that allows users to ask questions about a YouTube video. The video's transcript is fetched, split into chunks, converted into embeddings, stored in FAISS, and retrieved to provide context-aware answers using an LLM.

Features

Fetches YouTube video transcripts
Splits transcript into smaller chunks
Generates embeddings using Hugging Face
Stores embeddings in FAISS
Uses MMR retrieval
Uses Groq LLM for answering questions
Answers only from the video transcript
Supports multiple questions in the same session
Type exit to terminate the chat


Tech Stack

Python
LangChain
YouTube Transcript API
Hugging Face Embeddings
FAISS
Groq
GPT-OSS-120B