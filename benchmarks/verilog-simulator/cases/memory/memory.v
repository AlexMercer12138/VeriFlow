module memory_bench;
  integer i;
  reg [31:0] memory [0:4095];
  reg [63:0] checksum;

  initial begin
    checksum = 0;
    for (i = 0; i < 4096; i = i + 1)
      memory[i] = (i * 32'd2654435761) ^ 32'hc001d00d;
    for (i = 0; i < 4096; i = i + 1) begin
      if (memory[i] !== ((i * 32'd2654435761) ^ 32'hc001d00d)) begin
        $display("FAIL memory");
        $finish;
      end
      checksum = checksum + memory[i];
    end
    if ((^checksum) === 1'bx)
      $display("FAIL memory");
    else
      $display("PASS memory");
    $finish;
  end
endmodule
