from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_groq import ChatGroq
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_huggingface import HuggingFaceEmbeddings, ChatHuggingFace, HuggingFaceEndpoint,HuggingFacePipeline
from langchain_core.runnables import RunnableParallel, RunnablePassthrough, RunnableLambda
from langchain_core.output_parsers import StrOutputParser
from dotenv import load_dotenv

# indexing

load_dotenv()

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    temperature=0
)
video_id = "Gfr50f6ZBvo"  # only id,not url

try:
    api = YouTubeTranscriptApi()

    print("Processing video...")

    transcript_list = api.fetch(
        video_id,
        languages=["en", "hi"]
    )

    transcript = " ".join(chunk.text for chunk in transcript_list)

except TranscriptsDisabled:
    print("No caption available for this video")


# text_spliting

splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200
)

chunks = splitter.create_documents([transcript])


# Embedding Generation and storing in vectore store

embeddings = HuggingFaceEmbeddings(
    model_name="sentence-transformers/all-MiniLM-L6-v2"
)


print("getting ready..")

vector_store = FAISS.from_documents(
    chunks,
    embeddings
)


## Retrieval

retriever = vector_store.as_retriever(
    search_type="mmr",
    search_kwargs={"k": 4}
)


## Augmentation

prompt = PromptTemplate(
    template="""
            you are a helpful assistant.
            Anser ONLY from the provided transcript context.
            If the context is insufficient, just say you don't know.
            Do not use MARKDOWN.
            {context}

            question : {question}
""",
    input_variables=["context", "question"]
)


# question
def question():
    Question = input("Ask your question (type exit to terminate): ")
    return Question


# Building chain

def format_docs(retrieved_docs):
    context_text = "\n\n".join(
        doc.page_content for doc in retrieved_docs
    )
    return context_text


parallel_chain = RunnableParallel({
    "context": retriever | RunnableLambda(format_docs),
    "question": RunnablePassthrough()
})

parser = StrOutputParser()

final_chain = parallel_chain | prompt | llm | parser


while True:
    user_question = question()
    print("-"*30)
    print("Soution...")

    if user_question == "exit":
        print("Exiting...")
        break

    result = final_chain.invoke(user_question)

    print(result)