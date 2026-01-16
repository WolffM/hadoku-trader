from setuptools import setup, find_packages

with open("README.md", "r") as f:
    long_description = f.read()

setup(
    name="fidelity-api",
    version="1.0.0",
    author="Kenneth Tang",
    description="An unofficial API for Fidelity",
    long_description=long_description,
    long_description_content_type="text/markdown",
    license="GPL",
    url="https://github.com/kennyboy106/fidelity-api",
    keywords=["FIDELITY", "API", "TRADING", "AUTOMATION"],
    install_requires=[
        "playwright>=1.40.0",
        "playwright-stealth>=1.0.0",
        "pyotp>=2.8.0",
        "python-dotenv>=1.0.0",
    ],
    packages=find_packages(),
    python_requires=">=3.10",
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: GNU General Public License v3 (GPLv3)",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
