module counter_dut(input clk, input reset, output reg [31:0] count);
  always @(posedge clk) begin
    if (reset)
      count <= 32'd0;
    else
      count <= count + 1'b1;
  end
endmodule

module counter_bench;
  reg clk;
  reg reset;
  wire [31:0] count;

  counter_dut dut(.clk(clk), .reset(reset), .count(count));

  initial begin
    clk = 1'b0;
    reset = 1'b1;
    repeat (2) @(posedge clk);
    @(negedge clk);
    reset = 1'b0;
    repeat (100000) @(posedge clk);
    #1;
    if (count !== 32'd100000)
      $display("FAIL counter");
    else
      $display("PASS counter");
    $finish;
  end

  always #1 clk = ~clk;
endmodule
