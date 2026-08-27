module arithmetic_bench;
  integer i;
  reg [63:0] sum;
  reg [31:0] mix;

  initial begin
    sum = 64'd0;
    mix = 32'h13579bdf;
    for (i = 0; i < 100000; i = i + 1) begin
      sum = sum + i;
      mix = (mix + (i * 17)) ^ (mix >> 3);
    end
    if (sum !== 64'd4999950000 || mix !== 32'hf90e39ee)
      $display("FAIL arithmetic");
    else
      $display("PASS arithmetic");
    $finish;
  end
endmodule
