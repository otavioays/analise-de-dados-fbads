import PrivateConversionTool from "./PrivateConversionTool";

export default function Home() {
  return (
    <main
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "center",
        minHeight: "100svh",
        padding: 24,
      }}
    >
      <PrivateConversionTool />
    </main>
  );
}
