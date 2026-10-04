import os
import asyncio
from google import genai

async def test():
    try:
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents='test',
        )
        print("2.5 SUCCESS:", response.text)
    except Exception as e:
        print("2.5 ERROR:", e)

    try:
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        response = client.models.generate_content(
            model='gemini-2.0-flash',
            contents='test',
        )
        print("2.0 SUCCESS:", response.text)
    except Exception as e:
        print("2.0 ERROR:", e)
    
    try:
        client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        response = client.models.generate_content(
            model='gemini-3.8-flash',
            contents='test',
        )
        print("3.8 SUCCESS:", response.text)
    except Exception as e:
        print("3.8 ERROR:", e)

asyncio.run(test())
