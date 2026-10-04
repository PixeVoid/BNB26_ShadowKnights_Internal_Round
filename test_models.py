import os
import asyncio
from google import genai

async def test():
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    
    test_models = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
    for model in test_models:
        try:
            response = client.models.generate_content(
                model=model,
                contents='hi',
            )
            print(f"{model} SUCCESS: {response.text}")
        except Exception as e:
            print(f"{model} ERROR: {e}")

asyncio.run(test())
