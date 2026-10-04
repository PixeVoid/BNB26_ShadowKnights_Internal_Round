import os
import asyncio
from google import genai

async def test():
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    try:
        models = client.models.list()
        for m in models:
            print(f"Model: {m.name}")
    except Exception as e:
        print("Error listing models:", e)

asyncio.run(test())
